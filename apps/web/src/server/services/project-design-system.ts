/**
 * Which DesignSystemSpec a project renders with (Story 4.2):
 *   pinned published version         ->  that version's spec (immutable)
 *   no pin, system has been published ->  the latest published version
 *   no pin, never published           ->  the system's draft, or the built-in starter
 *
 * Draft edits therefore never reach a project once its system has a published version, and
 * publishing pins every unpinned project to what it was already showing (design-systems.ts), so a
 * newer version arrives only through an explicit upgrade.
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
import { draftSpecOf } from './design-systems';
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
  if (!ds)
    return {
      id: project.designSystemId,
      name: 'Starter',
      version: null,
      spec: starterDesignSystem(),
      latestVersion: null,
      pinned: false,
      upgradeAvailable: false,
    };
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
  return {
    id: ds.id,
    name: ds.name,
    version: null,
    spec: draftSpecOf(ds),
    latestVersion,
    pinned: false,
    upgradeAvailable: false,
  };
}

/** Version id a new project should pin (the latest published), or null if never published. */
export async function latestPublishedVersionId(
  db: Db,
  workspaceId: string,
  designSystemId: string,
): Promise<string | null> {
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
  const target = version ?? ds.latestVersion;
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
