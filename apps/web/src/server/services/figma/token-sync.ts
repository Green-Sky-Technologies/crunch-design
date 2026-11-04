/**
 * Token sync with Figma variables (Story 8.4), through the plugin.
 *
 * - diff:   compare the project's design-system draft with the file's variables (either direction)
 * - pull:   selected changes -> a validated DesignSystemSpec token patch; written to the draft by an
 *           injected `writeDraft` (owned by the design-system stream; see the integration notes)
 * - push:   selected changes -> a variables plan the plugin applies; the plugin then reports back
 *           and we record the new sync base
 * The diff is always recomputed server-side from the snapshot; the client only sends selections.
 * Conflicts are never auto-resolved.
 */
import { assertCan } from '@crunch/authz';
import { and, designSystems, eq, figmaVariableLinks, type Db } from '@crunch/db';
import { designSystemSpec, starterDesignSystem, type DesignSystemSpec } from '@crunch/doc-model';
import {
  agreedBase,
  applyTokenPatch,
  buildPullPatch,
  buildPushVariables,
  DEFAULT_COLLECTION,
  diffTokenSets,
  dsToTokenSet,
  InvalidPatchError,
  snapshotToTokenSet,
  UnresolvedConflictError,
  type ReportItem,
  type TokenDiff,
  type TokenPatch,
  type TokenSet,
  type VariablesSpec,
} from '@crunch/figma-convert';
import { z } from 'zod';
import { getProject } from '../projects';
import { NotFoundError, ValidationError, type Actor } from '../types';
import type { syncRequest } from './schemas';

export type SyncInput = z.infer<typeof syncRequest>;

/** Persists a new draft spec for a design system. Provided by the design-system service. */
export type DraftWriter = (
  db: Db,
  actor: Actor,
  designSystemId: string,
  spec: DesignSystemSpec,
  meta: { source: 'figma'; fileKey: string; label: string },
) => Promise<void>;

export interface TokenSyncDeps {
  writeDraft?: DraftWriter;
}

interface LinkMapping {
  base?: TokenSet;
  collectionId?: string;
  variableIds?: Record<string, string>;
}

async function context(db: Db, actor: Actor, projectId: string, fileKey: string) {
  const project = await getProject(db, actor, projectId);
  const [row] = await db
    .select()
    .from(designSystems)
    .where(
      and(
        eq(designSystems.id, project.designSystemId),
        eq(designSystems.workspaceId, actor.workspace.id),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError('Design system not found');
  const draft = row.draft ? designSystemSpec.safeParse(row.draft) : null;
  const spec = draft?.success ? draft.data : starterDesignSystem();
  const [link] = await db
    .select()
    .from(figmaVariableLinks)
    .where(
      and(
        eq(figmaVariableLinks.designSystemId, row.id),
        eq(figmaVariableLinks.figmaFileKey, fileKey),
      ),
    )
    .limit(1);
  const mapping = (link?.mapping ?? {}) as LinkMapping;
  return { ds: { id: row.id, name: row.name }, spec, mapping };
}

function compute(
  spec: DesignSystemSpec,
  input: SyncInput,
  base: TokenSet | null,
  direction: 'pull' | 'push',
) {
  const ours = dsToTokenSet(spec);
  const {
    set: theirs,
    report,
    collection,
  } = snapshotToTokenSet(input.snapshot, {
    existing: spec,
    collectionName: DEFAULT_COLLECTION,
  });
  const diff = diffTokenSets(ours, theirs, base, direction);
  return { ours, theirs, report, collection, diff };
}

function domain<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof UnresolvedConflictError)
      throw new ValidationError(e.message, { conflicts: e.keys });
    if (e instanceof InvalidPatchError) throw new ValidationError(e.message, { patch: e.issues });
    throw e;
  }
}

async function saveLink(
  db: Db,
  actor: Actor,
  designSystemId: string,
  fileKey: string,
  mapping: LinkMapping,
  stamp: 'lastPulledAt' | 'lastPushedAt',
) {
  const now = new Date();
  await db
    .insert(figmaVariableLinks)
    .values({
      workspaceId: actor.workspace.id,
      designSystemId,
      figmaFileKey: fileKey,
      mapping,
      [stamp]: now,
      createdBy: actor.userId,
    })
    .onConflictDoUpdate({
      target: [figmaVariableLinks.designSystemId, figmaVariableLinks.figmaFileKey],
      set: { mapping, [stamp]: now },
    });
}

export interface DiffResult extends TokenDiff {
  designSystem: { id: string; name: string };
  report: ReportItem[];
}

export async function diffVariables(
  db: Db,
  actor: Actor,
  projectId: string,
  input: SyncInput,
): Promise<DiffResult> {
  assertCan(actor.role, 'design_system:read');
  const { ds, spec, mapping } = await context(db, actor, projectId, input.fileKey);
  const { diff, report, collection } = compute(spec, input, mapping.base ?? null, input.direction);
  return {
    ...diff,
    collection: collection ? { id: collection.id, name: collection.name } : null,
    designSystem: ds,
    report,
  };
}

export interface PullResult {
  applied: boolean;
  designSystem: { id: string; name: string };
  patch: TokenPatch;
  /** The validated draft that results from the patch. */
  spec: DesignSystemSpec;
  message: string;
}

/** Figma -> design-system draft for the selected entries. */
export async function pullVariables(
  db: Db,
  actor: Actor,
  projectId: string,
  input: SyncInput,
  deps: TokenSyncDeps = {},
): Promise<PullResult> {
  assertCan(actor.role, 'design_system:edit');
  const { ds, spec, mapping } = await context(db, actor, projectId, input.fileKey);
  const { diff, theirs, collection } = compute(spec, input, mapping.base ?? null, 'pull');
  const sel = { selected: input.selected, resolutions: input.resolutions };
  const patch = domain(() => buildPullPatch(diff, theirs, sel));
  const next = domain(() => applyTokenPatch(spec, patch));
  if (!deps.writeDraft) {
    return {
      applied: false,
      designSystem: ds,
      patch,
      spec: next,
      message: 'Patch validated. Saving it to the design-system draft is not wired up yet.',
    };
  }
  await deps.writeDraft(db, actor, ds.id, next, {
    source: 'figma',
    fileKey: input.fileKey,
    label: `Pulled ${input.selected.length} token change(s) from Figma`,
  });
  await saveLink(
    db,
    actor,
    ds.id,
    input.fileKey,
    { ...mapping, collectionId: collection?.id, base: agreedBase(dsToTokenSet(next), theirs) },
    'lastPulledAt',
  );
  return { applied: true, designSystem: ds, patch, spec: next, message: 'Draft updated.' };
}

/** Design system -> Figma: the variables plan for the selected entries. */
export async function planVariablesPush(
  db: Db,
  actor: Actor,
  projectId: string,
  input: SyncInput,
): Promise<{ variables: VariablesSpec; remove: string[] }> {
  assertCan(actor.role, 'design_system:edit');
  const { spec, mapping } = await context(db, actor, projectId, input.fileKey);
  const { diff, ours, theirs, collection } = compute(spec, input, mapping.base ?? null, 'push');
  const { variables, remove } = domain(() =>
    buildPushVariables(
      diff,
      ours,
      theirs,
      { selected: input.selected, resolutions: input.resolutions },
      {
        collectionName: collection?.name ?? DEFAULT_COLLECTION,
      },
    ),
  );
  return { variables, remove };
}

/** After the plugin applied a push: record the new base from the file's fresh variables. */
export async function recordVariablesPush(
  db: Db,
  actor: Actor,
  projectId: string,
  input: Pick<SyncInput, 'fileKey' | 'snapshot'>,
): Promise<{ synced: number }> {
  assertCan(actor.role, 'design_system:edit');
  const { ds, spec, mapping } = await context(db, actor, projectId, input.fileKey);
  const { set: theirs, collection } = snapshotToTokenSet(input.snapshot, {
    existing: spec,
    collectionName: DEFAULT_COLLECTION,
  });
  const base = agreedBase(dsToTokenSet(spec), theirs);
  const variableIds: Record<string, string> = {};
  for (const v of collection?.variables ?? []) if (v.tokenPath) variableIds[v.tokenPath] = v.id;
  await saveLink(
    db,
    actor,
    ds.id,
    input.fileKey,
    { ...mapping, base, collectionId: collection?.id, variableIds },
    'lastPushedAt',
  );
  return { synced: Object.keys(base.tokens).length };
}
