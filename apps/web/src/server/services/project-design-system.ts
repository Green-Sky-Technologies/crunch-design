/**
 * Which DesignSystemSpec a project renders with:
 *   pinned published version  ->  that version's spec
 *   no pin                    ->  the system's draft, or the built-in starter if never edited
 * stream-design-system owns editing/publishing (services/design-systems.ts) and may extend this.
 */
import { assertCan } from '@crunch/authz';
import { and, designSystems, designSystemVersions, eq, type Db, type Project } from '@crunch/db';
import { designSystemSpec, starterDesignSystem, type DesignSystemSpec } from '@crunch/doc-model';
import type { Actor } from './types';

export interface ResolvedDesignSystem {
  id: string;
  name: string;
  version: number | null;
  spec: DesignSystemSpec;
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
    };
  if (project.designSystemVersionId) {
    const [v] = await db
      .select()
      .from(designSystemVersions)
      .where(
        and(
          eq(designSystemVersions.id, project.designSystemVersionId),
          eq(designSystemVersions.designSystemId, ds.id),
        ),
      )
      .limit(1);
    if (v)
      return { id: ds.id, name: ds.name, version: v.version, spec: designSystemSpec.parse(v.spec) };
  }
  const draft = ds.draft ? designSystemSpec.safeParse(ds.draft) : null;
  return {
    id: ds.id,
    name: ds.name,
    version: null,
    spec: draft?.success ? draft.data : starterDesignSystem(),
  };
}
