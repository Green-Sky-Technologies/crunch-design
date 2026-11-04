/**
 * Design systems (Epic 4): workspace systems, their editable draft, and immutable published
 * versions. Every write is validated with `safeParseSpec` (doc-model schema + cross-reference
 * invariants), so an invalid spec is never stored.
 *
 *   draft      design_systems.draft (null until first edited = the built-in starter)
 *   publish    snapshot the draft into design_system_versions(version = latestVersion + 1)
 *   projects   pin a version (see project-design-system.ts)
 */
import { assertCan } from '@crunch/authz';
import {
  and,
  asc,
  designSystems,
  designSystemVersions,
  desc,
  eq,
  inArray,
  isNull,
  projects,
  sql,
  type Db,
  type DesignSystem,
} from '@crunch/db';
import {
  componentDef,
  designSystemSpec,
  starterDesignSystem,
  tokenDef,
  type ComponentDef,
  type DesignSystemSpec,
  type TokenDef,
} from '@crunch/doc-model';
import { z } from 'zod';
import { safeParseSpec, specsEqual, type SpecIssue } from './design-systems/spec';
import { NotFoundError, ValidationError, type Actor } from './types';

export { safeParseSpec, type SpecIssue } from './design-systems/spec';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Conn = Db | Tx;

const nameSchema = z.string().trim().min(1, 'Name is required').max(80, 'Name is too long');
const descriptionSchema = z.string().trim().max(1000, 'Description is too long');
const notesSchema = z.string().trim().max(2000, 'Notes are too long');

export interface DesignSystemSummary {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  /** Latest published version number, or null if never published. */
  latestVersion: number | null;
  /** True when the draft differs from the latest published version (or nothing is published). */
  hasUnpublishedChanges: boolean;
  /** Non-archived projects that use this system. */
  projectCount: number;
  updatedAt: Date;
  /** Opaque optimistic-concurrency token for draft saves. */
  revision: string;
}

export interface DesignSystemVersionSummary {
  id: string;
  version: number;
  notes: string | null;
  publishedBy: string;
  publishedAt: Date;
}

export interface DesignSystemDetail {
  system: DesignSystemSummary;
  draft: DesignSystemSpec;
  versions: DesignSystemVersionSummary[];
}

export type NewSystemSource =
  | { kind: 'starter' }
  | { kind: 'blank' }
  | { kind: 'copy'; designSystemId: string; version?: number };

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function parseField<T>(schema: z.ZodType<T>, value: unknown, field: string): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const msg = r.error.issues[0]?.message ?? 'Invalid value';
    throw new ValidationError(msg, { [field]: [msg] });
  }
  return r.data;
}

/** Validate a spec for storage, or throw ValidationError listing the first issues. */
export function validateSpecOrThrow(input: unknown): DesignSystemSpec {
  const r = safeParseSpec(input);
  if (r.ok) return r.spec;
  throw specError(r.issues);
}

function specError(issues: SpecIssue[]): ValidationError {
  const fieldErrors: Record<string, string[]> = {};
  for (const i of issues.slice(0, 50)) (fieldErrors[i.path || 'spec'] ??= []).push(i.message);
  const first = issues[0];
  return new ValidationError(
    `Invalid design system${first ? `: ${first.path ? `${first.path}: ` : ''}${first.message}` : ''}`,
    fieldErrors,
  );
}

/** The spec a row's draft represents (the starter until first edited). */
export function draftSpecOf(row: Pick<DesignSystem, 'draft'>): DesignSystemSpec {
  if (row.draft == null) return starterDesignSystem();
  // Shape-only on read: a draft stored before an invariant was tightened still loads (the editor
  // shows its issues and won't save until they're fixed) instead of silently becoming the starter.
  const r = designSystemSpec.safeParse(row.draft);
  return r.success ? r.data : starterDesignSystem();
}

/** Assigning this leaves updated_at as it is (overrides the schema's $onUpdate). */
const KEEP_UPDATED_AT = sql`${designSystems.updatedAt}`;

export const revisionOf = (row: Pick<DesignSystem, 'updatedAt'>) => String(row.updatedAt.getTime());

function blankSpec(): DesignSystemSpec {
  return validateSpecOrThrow({ schemaVersion: 1, tokens: {} });
}

/** Load a non-archived system in the actor's workspace (optionally row-locked). */
async function loadRow(
  conn: Conn,
  actor: Actor,
  id: string,
  opts: { lock?: boolean; includeArchived?: boolean } = {},
): Promise<DesignSystem> {
  if (!z.uuid().safeParse(id).success) throw new NotFoundError('Design system not found');
  const where = and(eq(designSystems.id, id), eq(designSystems.workspaceId, actor.workspace.id));
  const q = conn.select().from(designSystems).where(where).limit(1);
  const [row] = opts.lock ? await q.for('update') : await q;
  if (!row || (row.archivedAt && !opts.includeArchived))
    throw new NotFoundError('Design system not found');
  return row;
}

async function versionSpec(
  conn: Conn,
  designSystemId: string,
  version: number,
): Promise<DesignSystemSpec | null> {
  const [v] = await conn
    .select({ spec: designSystemVersions.spec })
    .from(designSystemVersions)
    .where(
      and(
        eq(designSystemVersions.designSystemId, designSystemId),
        eq(designSystemVersions.version, version),
      ),
    )
    .limit(1);
  // Shape-only on read: immutable versions stay readable if invariants are tightened later.
  return v ? designSystemSpec.parse(v.spec) : null;
}

async function versionId(
  conn: Conn,
  designSystemId: string,
  version: number,
): Promise<string | null> {
  const [v] = await conn
    .select({ id: designSystemVersions.id })
    .from(designSystemVersions)
    .where(
      and(
        eq(designSystemVersions.designSystemId, designSystemId),
        eq(designSystemVersions.version, version),
      ),
    )
    .limit(1);
  return v?.id ?? null;
}

async function summarize(conn: Conn, rows: DesignSystem[]): Promise<DesignSystemSummary[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const counts = await conn
    .select({ id: projects.designSystemId, n: sql<number>`count(*)::int` })
    .from(projects)
    .where(and(inArray(projects.designSystemId, ids), isNull(projects.archivedAt)))
    .groupBy(projects.designSystemId);
  const countBy = new Map(counts.map((c) => [c.id, Number(c.n)]));
  return Promise.all(
    rows.map(async (row) => {
      let hasUnpublishedChanges = true;
      if (row.latestVersion !== null) {
        const latest = await versionSpec(conn, row.id, row.latestVersion);
        hasUnpublishedChanges = !latest || !specsEqual(latest, draftSpecOf(row));
      }
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        isDefault: row.isDefault,
        latestVersion: row.latestVersion,
        hasUnpublishedChanges,
        projectCount: countBy.get(row.id) ?? 0,
        updatedAt: row.updatedAt,
        revision: revisionOf(row),
      };
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------------------------

/** publishedBy for versions created by the system rather than a person. */
export const SYSTEM_PUBLISHER = 'system';

async function insertFirstVersion(
  tx: Tx,
  row: DesignSystem,
  spec: DesignSystemSpec,
  publishedBy: string,
): Promise<DesignSystem> {
  const [v] = await tx
    .insert(designSystemVersions)
    .values({
      designSystemId: row.id,
      workspaceId: row.workspaceId,
      version: 1,
      spec,
      notes: 'Initial version',
      publishedBy,
    })
    .returning({ id: designSystemVersions.id });
  const [updated] = await tx
    .update(designSystems)
    .set({ latestVersion: 1, draft: spec, updatedAt: KEEP_UPDATED_AT })
    .where(eq(designSystems.id, row.id))
    .returning();
  // Projects that were following the (never published) system now pin v1, which is exactly what
  // they rendered before.
  await tx
    .update(projects)
    .set({ designSystemVersionId: v!.id })
    .where(and(eq(projects.designSystemId, row.id), isNull(projects.designSystemVersionId)));
  return updated!;
}

/**
 * Projects never render a mutable draft (Story 4.2), so every system needs a published version.
 * New systems get v1 on create; systems created elsewhere (the workspace default made by
 * upsertWorkspace, legacy rows) get it here on first access. Idempotent and race-safe: the row is
 * locked and latestVersion re-checked before inserting. Returns the (possibly updated) row, or null
 * if it isn't in the workspace.
 */
export async function ensurePublished(
  db: Db,
  workspaceId: string,
  id: string,
  publishedBy = SYSTEM_PUBLISHER,
): Promise<DesignSystem | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(designSystems)
      .where(and(eq(designSystems.id, id), eq(designSystems.workspaceId, workspaceId)))
      .limit(1)
      .for('update');
    if (!row || row.latestVersion !== null) return row ?? null;
    const draft = safeParseSpec(row.draft ?? starterDesignSystem());
    return insertFirstVersion(tx, row, draft.ok ? draft.spec : starterDesignSystem(), publishedBy);
  });
}

async function ensureAllPublished(db: Db, rows: DesignSystem[]): Promise<DesignSystem[]> {
  return Promise.all(
    rows.map(async (r) =>
      r.latestVersion === null ? ((await ensurePublished(db, r.workspaceId, r.id)) ?? r) : r,
    ),
  );
}

export async function listDesignSystems(db: Db, actor: Actor): Promise<DesignSystemSummary[]> {
  assertCan(actor.role, 'design_system:read');
  const rows = await db
    .select()
    .from(designSystems)
    .where(and(eq(designSystems.workspaceId, actor.workspace.id), isNull(designSystems.archivedAt)))
    .orderBy(desc(designSystems.isDefault), asc(designSystems.name), asc(designSystems.createdAt));
  return summarize(db, await ensureAllPublished(db, rows));
}

export async function getDesignSystem(
  db: Db,
  actor: Actor,
  id: string,
): Promise<DesignSystemDetail> {
  assertCan(actor.role, 'design_system:read');
  const [row] = await ensureAllPublished(db, [await loadRow(db, actor, id)]);
  const [system] = await summarize(db, [row!]);
  return {
    system: system!,
    draft: draftSpecOf(row!),
    versions: await listVersionsFor(db, row!.id),
  };
}

async function listVersionsFor(conn: Conn, id: string): Promise<DesignSystemVersionSummary[]> {
  return conn
    .select({
      id: designSystemVersions.id,
      version: designSystemVersions.version,
      notes: designSystemVersions.notes,
      publishedBy: designSystemVersions.publishedBy,
      publishedAt: designSystemVersions.publishedAt,
    })
    .from(designSystemVersions)
    .where(eq(designSystemVersions.designSystemId, id))
    .orderBy(desc(designSystemVersions.version));
}

export async function listDesignSystemVersions(
  db: Db,
  actor: Actor,
  id: string,
): Promise<DesignSystemVersionSummary[]> {
  assertCan(actor.role, 'design_system:read');
  const row = await loadRow(db, actor, id, { includeArchived: true });
  return listVersionsFor(db, row.id);
}

/** A published version's spec (immutable). */
export async function getDesignSystemVersionSpec(
  db: Db,
  actor: Actor,
  id: string,
  version: number,
): Promise<DesignSystemSpec> {
  assertCan(actor.role, 'design_system:read');
  const row = await loadRow(db, actor, id, { includeArchived: true });
  const spec = Number.isInteger(version) ? await versionSpec(db, row.id, version) : null;
  if (!spec) throw new NotFoundError('Version not found');
  return spec;
}

// ---------------------------------------------------------------------------------------------
// systems
// ---------------------------------------------------------------------------------------------

export async function createDesignSystem(
  db: Db,
  actor: Actor,
  input: { name: unknown; description?: unknown; source?: NewSystemSource },
): Promise<DesignSystemSummary> {
  assertCan(actor.role, 'design_system:edit');
  const name = parseField(nameSchema, input.name, 'name');
  const description = input.description
    ? parseField(descriptionSchema, input.description, 'description') || null
    : null;
  const source = input.source ?? { kind: 'starter' };
  let spec: DesignSystemSpec;
  if (source.kind === 'blank') spec = blankSpec();
  else if (source.kind === 'starter') spec = starterDesignSystem();
  else {
    const src = await loadRow(db, actor, source.designSystemId);
    if (source.version === undefined) spec = draftSpecOf(src);
    else {
      const v = await versionSpec(db, src.id, source.version);
      if (!v) throw new NotFoundError('Version not found');
      spec = v;
    }
  }
  const valid = validateSpecOrThrow(spec);
  // The system and its v1 are created together, so no project can ever render its draft.
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(designSystems)
      .values({
        workspaceId: actor.workspace.id,
        name,
        description,
        draft: valid,
        updatedBy: actor.userId,
      })
      .returning();
    return insertFirstVersion(tx, created!, valid, actor.userId);
  });
  return (await summarize(db, [row]))[0]!;
}

export async function updateDesignSystemDetails(
  db: Db,
  actor: Actor,
  id: string,
  input: { name?: unknown; description?: unknown },
): Promise<DesignSystemSummary> {
  assertCan(actor.role, 'design_system:edit');
  await loadRow(db, actor, id);
  // Metadata isn't part of the draft: keep updatedAt (the draft revision) so an open editor's
  // next save or publish isn't rejected as a concurrent edit.
  const set: { name?: string; description?: string | null } = {};
  if (input.name !== undefined) set.name = parseField(nameSchema, input.name, 'name');
  if (input.description !== undefined)
    set.description = parseField(descriptionSchema, input.description ?? '', 'description') || null;
  const [row] = await db
    .update(designSystems)
    .set({ ...set, updatedAt: KEEP_UPDATED_AT })
    .where(and(eq(designSystems.id, id), eq(designSystems.workspaceId, actor.workspace.id)))
    .returning();
  return (await summarize(db, [row!]))[0]!;
}

/** New projects use the workspace default system (projects.ts picks it). */
export async function setDefaultDesignSystem(db: Db, actor: Actor, id: string): Promise<void> {
  assertCan(actor.role, 'design_system:edit');
  await db.transaction(async (tx) => {
    await loadRow(tx, actor, id, { lock: true });
    await tx
      .update(designSystems)
      .set({ isDefault: false, updatedAt: KEEP_UPDATED_AT })
      .where(
        and(eq(designSystems.workspaceId, actor.workspace.id), eq(designSystems.isDefault, true)),
      );
    await tx
      .update(designSystems)
      .set({ isDefault: true, updatedAt: KEEP_UPDATED_AT })
      .where(and(eq(designSystems.id, id), eq(designSystems.workspaceId, actor.workspace.id)));
  });
}

/** Soft-delete. The default system and systems still used by projects can't be archived. */
export async function archiveDesignSystem(db: Db, actor: Actor, id: string): Promise<void> {
  assertCan(actor.role, 'design_system:edit');
  await db.transaction(async (tx) => {
    const row = await loadRow(tx, actor, id, { lock: true });
    if (row.isDefault)
      throw new ValidationError('Make another system the default before archiving this one');
    const [used] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(projects)
      .where(and(eq(projects.designSystemId, id), isNull(projects.archivedAt)));
    if (Number(used?.n ?? 0) > 0)
      throw new ValidationError('Switch the projects that use this system before archiving it');
    await tx
      .update(designSystems)
      .set({ archivedAt: new Date(), updatedBy: actor.userId })
      .where(eq(designSystems.id, id));
  });
}

// ---------------------------------------------------------------------------------------------
// draft
// ---------------------------------------------------------------------------------------------

export interface SaveDraftResult {
  revision: string;
  spec: DesignSystemSpec;
}

/**
 * Apply `mutate` to the current draft under a row lock, validate, and store.
 * `baseRevision` (from a previous read) rejects the write if someone else saved in between.
 */
async function writeDraft(
  db: Db,
  actor: Actor,
  id: string,
  mutate: (draft: DesignSystemSpec) => unknown,
  baseRevision?: string,
): Promise<SaveDraftResult> {
  assertCan(actor.role, 'design_system:edit');
  return db.transaction(async (tx) => {
    const row = await loadRow(tx, actor, id, { lock: true });
    if (baseRevision !== undefined && baseRevision !== revisionOf(row)) {
      throw new ValidationError(
        'This design system was changed by someone else. Reload to get the latest draft.',
        { revision: ['stale'] },
      );
    }
    const spec = validateSpecOrThrow(mutate(structuredClone(draftSpecOf(row))));
    const [updated] = await tx
      .update(designSystems)
      .set({ draft: spec, updatedBy: actor.userId, updatedAt: new Date() })
      .where(eq(designSystems.id, row.id))
      .returning();
    return { revision: revisionOf(updated!), spec };
  });
}

/** Replace the whole draft (the editor saves this way). */
export async function saveDesignSystemDraft(
  db: Db,
  actor: Actor,
  id: string,
  input: { spec: unknown; baseRevision?: string },
): Promise<SaveDraftResult> {
  return writeDraft(db, actor, id, () => input.spec, input.baseRevision);
}

/** Create, replace (def) or delete (null) one token. Deleting a token that's still referenced fails. */
export async function setDesignSystemToken(
  db: Db,
  actor: Actor,
  id: string,
  path: string,
  def: unknown,
): Promise<SaveDraftResult> {
  const parsed = def === null ? null : parseField(tokenDef, def, `tokens.${path}`);
  return writeDraft(db, actor, id, (spec) => {
    if (parsed === null) {
      if (!spec.tokens[path]) throw new NotFoundError(`Token "${path}" not found`);
      delete spec.tokens[path];
      for (const t of Object.values(spec.themes)) delete t[path];
    } else spec.tokens[path] = parsed as TokenDef;
    return spec;
  });
}

export async function upsertDesignSystemComponent(
  db: Db,
  actor: Actor,
  id: string,
  def: unknown,
): Promise<SaveDraftResult> {
  const parsed = parseField(componentDef, def, 'component') as ComponentDef;
  return writeDraft(db, actor, id, (spec) => {
    spec.components[parsed.id] = parsed;
    return spec;
  });
}

export async function removeDesignSystemComponent(
  db: Db,
  actor: Actor,
  id: string,
  componentId: string,
): Promise<SaveDraftResult> {
  return writeDraft(db, actor, id, (spec) => {
    if (!spec.components[componentId]) throw new NotFoundError('Component not found');
    delete spec.components[componentId];
    return spec;
  });
}

/** Throw away unpublished draft edits: the draft becomes the latest published spec again. */
export async function discardDesignSystemDraft(
  db: Db,
  actor: Actor,
  id: string,
): Promise<SaveDraftResult> {
  assertCan(actor.role, 'design_system:edit');
  const row = await loadRow(db, actor, id);
  if (row.latestVersion === null) throw new ValidationError('Nothing has been published yet');
  const latest = await versionSpec(db, row.id, row.latestVersion);
  return writeDraft(db, actor, id, () => latest);
}

// ---------------------------------------------------------------------------------------------
// publishing (Story 4.2)
// ---------------------------------------------------------------------------------------------

/**
 * Snapshot the draft into a new immutable version and bump latestVersion. Concurrent publishes
 * serialize on the row lock (and the (system, version) unique index backs that up).
 */
export async function publishDesignSystem(
  db: Db,
  actor: Actor,
  id: string,
  input: { notes?: unknown; baseRevision?: string } = {},
): Promise<DesignSystemVersionSummary & { revision: string }> {
  assertCan(actor.role, 'design_system:edit');
  const notes = input.notes ? parseField(notesSchema, input.notes, 'notes') || null : null;
  return db.transaction(async (tx) => {
    const row = await loadRow(tx, actor, id, { lock: true });
    if (input.baseRevision !== undefined && input.baseRevision !== revisionOf(row))
      throw new ValidationError(
        'The draft changed since you loaded it. Reload and review it before publishing.',
        { revision: ['stale'] },
      );
    const spec = validateSpecOrThrow(draftSpecOf(row));
    if (row.latestVersion !== null) {
      const latest = await versionSpec(tx, row.id, row.latestVersion);
      if (latest && specsEqual(latest, spec))
        throw new ValidationError(`Nothing changed since version ${row.latestVersion}`);
    }
    const version = (row.latestVersion ?? 0) + 1;
    const previousId =
      row.latestVersion === null ? null : await versionId(tx, row.id, row.latestVersion);
    const [v] = await tx
      .insert(designSystemVersions)
      .values({
        designSystemId: row.id,
        workspaceId: actor.workspace.id,
        version,
        spec,
        notes,
        publishedBy: actor.userId,
      })
      .returning();
    const [updated] = await tx
      .update(designSystems)
      .set({ latestVersion: version, draft: spec, updatedBy: actor.userId, updatedAt: new Date() })
      .where(eq(designSystems.id, row.id))
      .returning();
    // Publishing never changes what an existing project renders. Unpinned projects were showing
    // the previous latest version (or, before the first publish, the draft that just became v1),
    // so pin them to exactly that. They then get the upgrade prompt for the new version.
    await tx
      .update(projects)
      .set({ designSystemVersionId: previousId ?? v!.id })
      .where(
        and(
          eq(projects.workspaceId, actor.workspace.id),
          eq(projects.designSystemId, row.id),
          isNull(projects.designSystemVersionId),
        ),
      );
    return {
      id: v!.id,
      version: v!.version,
      notes: v!.notes,
      publishedBy: v!.publishedBy,
      publishedAt: v!.publishedAt,
      revision: revisionOf(updated!),
    };
  });
}
