/**
 * Which DesignSystemSpec a project renders with (Story 4.2). A project never renders a mutable
 * draft:
 *   pinned published version  ->  that version's spec (immutable)
 *   no pin                    ->  the latest published version
 *   system never published    ->  v1 is published from its draft first (ensurePublished); if
 *                                 that's impossible, the built-in starter
 *
 * Every system gets v1 when it's created, publishing pins each unpinned project to what it was
 * already showing, and so a newer version only arrives through an explicit upgrade or switch.
 *
 * Integration point (projects.ts is owned elsewhere): createProject should set
 * `designSystemVersionId: await latestPublishedVersionId(db, workspaceId, designSystemId)` and
 * duplicateProject should copy `designSystemVersionId`. Until then the "no pin" rule above keeps
 * those projects on the latest published version, and the next publish pins them.
 */
import { assertCan } from '@crunch/authz';
import {
  and,
  asc,
  designSystems,
  designSystemVersions,
  eq,
  isNull,
  projects,
  type Db,
  type Project,
} from '@crunch/db';
import { designSystemSpec, starterDesignSystem, type DesignSystemSpec } from '@crunch/doc-model';
import { z } from 'zod';
import { getDoc } from './design-docs';
import { ensurePublished } from './design-systems';
import { diffSystemsForDoc, type SystemDiff } from './design-systems/diff';
import { getProject } from './projects';
import { NotFoundError, ValidationError, type Actor } from './types';

export interface ResolvedDesignSystem {
  id: string;
  name: string;
  /** Version the project renders, or null when it renders the draft/starter. */
  version: number | null;
  spec: DesignSystemSpec;
  /** Latest published version of the system (null = never published). */
  latestVersion: number | null;
  /** The project is explicitly pinned (vs. following the latest/draft). */
  pinned: boolean;
  /** A newer published version than the pinned one exists. */
  upgradeAvailable: boolean;
}

async function versionRow(
  db: Db,
  designSystemId: string,
  where: { id?: string; version?: number },
) {
  const [v] = await db
    .select()
    .from(designSystemVersions)
    .where(
      and(
        eq(designSystemVersions.designSystemId, designSystemId),
        where.id !== undefined
          ? eq(designSystemVersions.id, where.id)
          : eq(designSystemVersions.version, where.version!),
      ),
    )
    .limit(1);
  return v;
}

export async function resolveProjectDesignSystem(
  db: Db,
  actor: Actor,
  project: Project,
): Promise<ResolvedDesignSystem> {
  assertCan(actor.role, 'design_system:read');
  const starter = (name = 'Starter'): ResolvedDesignSystem => ({
    id: project.designSystemId,
    name,
    version: null,
    spec: starterDesignSystem(),
    latestVersion: null,
    pinned: false,
    upgradeAvailable: false,
  });
  let [ds] = await db
    .select()
    .from(designSystems)
    .where(
      and(
        eq(designSystems.id, project.designSystemId),
        eq(designSystems.workspaceId, actor.workspace.id),
      ),
    )
    .limit(1);
  if (!ds) return starter();
  if (ds.latestVersion === null) {
    // Never published (e.g. the workspace default created by upsertWorkspace): publish v1 now
    // rather than render the mutable draft. If that fails, render the built-in starter.
    try {
      ds = (await ensurePublished(db, actor.workspace.id, ds.id)) ?? ds;
    } catch (err) {
      console.error('[design-systems] could not create v1', err instanceof Error ? err.name : err);
    }
  }
  const latestVersion = ds.latestVersion;
  if (project.designSystemVersionId) {
    const v = await versionRow(db, ds.id, { id: project.designSystemVersionId });
    if (v)
      return {
        id: ds.id,
        name: ds.name,
        version: v.version,
        spec: designSystemSpec.parse(v.spec),
        latestVersion,
        pinned: true,
        upgradeAvailable: latestVersion !== null && latestVersion > v.version,
      };
  }
  if (latestVersion !== null) {
    const v = await versionRow(db, ds.id, { version: latestVersion });
    if (v)
      return {
        id: ds.id,
        name: ds.name,
        version: v.version,
        spec: designSystemSpec.parse(v.spec),
        latestVersion,
        pinned: false,
        upgradeAvailable: false,
      };
  }
  // No published version could be found or created: never fall back to the draft.
  return { ...starter(ds.name), id: ds.id };
}

/** Version id a new project should pin (the latest published), or null if never published. */
export async function latestPublishedVersionId(
  db: Db,
  workspaceId: string,
  designSystemId: string,
): Promise<string | null> {
  await ensurePublished(db, workspaceId, designSystemId);
  const [row] = await db
    .select({ id: designSystemVersions.id })
    .from(designSystems)
    .innerJoin(
      designSystemVersions,
      and(
        eq(designSystemVersions.designSystemId, designSystems.id),
        eq(designSystemVersions.version, designSystems.latestVersion),
      ),
    )
    .where(and(eq(designSystems.id, designSystemId), eq(designSystems.workspaceId, workspaceId)))
    .limit(1);
  return row?.id ?? null;
}

export interface ProjectDesignSystemStatus {
  projectId: string;
  projectName: string;
  designSystemId: string;
  designSystemName: string;
  /** Version the project renders (null = draft/starter). */
  version: number | null;
  latestVersion: number | null;
  pinned: boolean;
  upgradeAvailable: boolean;
}

/** Every active project with its system and version (design-systems page, upgrade prompts). */
export async function listProjectDesignSystems(
  db: Db,
  actor: Actor,
): Promise<ProjectDesignSystemStatus[]> {
  assertCan(actor.role, 'project:read');
  assertCan(actor.role, 'design_system:read');
  // Make sure every system in use has a v1, so no row reports a draft.
  const unpublished = await db
    .select({ id: designSystems.id })
    .from(designSystems)
    .where(
      and(eq(designSystems.workspaceId, actor.workspace.id), isNull(designSystems.latestVersion)),
    );
  for (const u of unpublished) await ensurePublished(db, actor.workspace.id, u.id);
  const rows = await db
    .select({
      projectId: projects.id,
      projectName: projects.name,
      designSystemId: designSystems.id,
      designSystemName: designSystems.name,
      pinnedVersion: designSystemVersions.version,
      latestVersion: designSystems.latestVersion,
    })
    .from(projects)
    .innerJoin(designSystems, eq(designSystems.id, projects.designSystemId))
    .leftJoin(designSystemVersions, eq(designSystemVersions.id, projects.designSystemVersionId))
    .where(and(eq(projects.workspaceId, actor.workspace.id), isNull(projects.archivedAt)))
    .orderBy(asc(projects.name));
  return rows.map((r) => {
    const pinned = r.pinnedVersion !== null;
    return {
      projectId: r.projectId,
      projectName: r.projectName,
      designSystemId: r.designSystemId,
      designSystemName: r.designSystemName,
      version: pinned ? r.pinnedVersion : r.latestVersion,
      latestVersion: r.latestVersion,
      pinned,
      upgradeAvailable: pinned && r.latestVersion !== null && r.latestVersion > r.pinnedVersion!,
    };
  });
}

/**
 * Pin a project to a published version of its current system (default: the latest). This is the
 * upgrade action; it can also roll back to an older version.
 */
export async function pinProjectDesignSystemVersion(
  db: Db,
  actor: Actor,
  projectId: string,
  version?: number,
): Promise<ResolvedDesignSystem> {
  assertCan(actor.role, 'project:update');
  assertCan(actor.role, 'design_system:read');
  const project = await getProject(db, actor, projectId);
  const [ds] = await db
    .select()
    .from(designSystems)
    .where(
      and(
        eq(designSystems.id, project.designSystemId),
        eq(designSystems.workspaceId, actor.workspace.id),
      ),
    )
    .limit(1);
  if (!ds) throw new NotFoundError('Design system not found');
  const latest =
    ds.latestVersion ??
    (await ensurePublished(db, actor.workspace.id, ds.id))?.latestVersion ??
    null;
  const target = version ?? latest;
  if (target === null) throw new ValidationError('This design system has not been published yet');
  const v = Number.isInteger(target) ? await versionRow(db, ds.id, { version: target }) : undefined;
  if (!v) throw new NotFoundError('Version not found');
  const [updated] = await db
    .update(projects)
    .set({ designSystemVersionId: v.id })
    .where(and(eq(projects.id, project.id), eq(projects.workspaceId, actor.workspace.id)))
    .returning();
  return resolveProjectDesignSystem(db, actor, updated!);
}

// ---------------------------------------------------------------------------------------------
// switching systems (Story 4.3)
// ---------------------------------------------------------------------------------------------

export interface SwitchTarget {
  designSystemId: string;
  /** A published version; default = the latest published (or the draft if never published). */
  version?: number;
}

interface ResolvedTarget {
  id: string;
  name: string;
  version: number | null;
  versionId: string | null;
  spec: DesignSystemSpec;
}

async function resolveTarget(db: Db, actor: Actor, target: SwitchTarget): Promise<ResolvedTarget> {
  if (!z.uuid().safeParse(target.designSystemId).success)
    throw new NotFoundError('Design system not found');
  const [ds] = await db
    .select()
    .from(designSystems)
    .where(
      and(
        eq(designSystems.id, target.designSystemId),
        eq(designSystems.workspaceId, actor.workspace.id),
        isNull(designSystems.archivedAt),
      ),
    )
    .limit(1);
  if (!ds) throw new NotFoundError('Design system not found');
  // Switching always pins a real version: publish v1 first if the target never was.
  const latest =
    ds.latestVersion ?? (await ensurePublished(db, actor.workspace.id, ds.id))?.latestVersion;
  const version = target.version ?? latest;
  if (version === null || version === undefined)
    throw new ValidationError('This design system has no published version');
  const v = Number.isInteger(version) ? await versionRow(db, ds.id, { version }) : undefined;
  if (!v) throw new NotFoundError('Version not found');
  return {
    id: ds.id,
    name: ds.name,
    version: v.version,
    versionId: v.id,
    spec: designSystemSpec.parse(v.spec),
  };
}

export interface SwitchPreview {
  current: { id: string; name: string; version: number | null };
  target: { id: string; name: string; version: number | null };
  diff: SystemDiff;
}

/** What would change in this project's design if it used `target` (nothing is written). */
export async function previewProjectDesignSystemSwitch(
  db: Db,
  actor: Actor,
  projectId: string,
  target: SwitchTarget,
): Promise<SwitchPreview> {
  assertCan(actor.role, 'design_system:read');
  const project = await getProject(db, actor, projectId);
  const [current, next, state] = await Promise.all([
    resolveProjectDesignSystem(db, actor, project),
    resolveTarget(db, actor, target),
    getDoc(db, actor, project.id),
  ]);
  return {
    current: { id: current.id, name: current.name, version: current.version },
    target: { id: next.id, name: next.name, version: next.version },
    diff: diffSystemsForDoc(state.doc, current.spec, next.spec),
  };
}

/**
 * Move a project to another design system (or another version of its own). It pins the target's
 * published version; a never-published target leaves the project on that system's draft.
 */
export async function switchProjectDesignSystem(
  db: Db,
  actor: Actor,
  projectId: string,
  target: SwitchTarget,
): Promise<ResolvedDesignSystem> {
  assertCan(actor.role, 'project:update');
  assertCan(actor.role, 'design_system:read');
  const project = await getProject(db, actor, projectId);
  const next = await resolveTarget(db, actor, target);
  const [updated] = await db
    .update(projects)
    .set({ designSystemId: next.id, designSystemVersionId: next.versionId })
    .where(and(eq(projects.id, project.id), eq(projects.workspaceId, actor.workspace.id)))
    .returning();
  return resolveProjectDesignSystem(db, actor, updated!);
}
