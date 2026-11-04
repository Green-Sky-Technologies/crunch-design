/**
 * Figma integration services (Epic 8). Framework-free: `(db, actor, input)`, like every service.
 * The plugin reaches these through `/api/figma/plugin/**` (bearer plugin tokens); the web app
 * reaches them through server actions and `/api/figma/**` (Clerk session).
 */
import { assertCan } from '@crunch/authz';
import { type Db } from '@crunch/db';
import { walk } from '@crunch/doc-model';
import { getDoc } from './design-docs';
import { listProjects } from './projects';
import type { Actor } from './types';

export interface PluginProject {
  id: string;
  name: string;
  updatedAt: string;
}

export interface PluginFrame {
  id: string;
  name: string;
  width: number;
  height: number | 'auto';
  nodeCount: number;
}

/** Who the plugin is connected as. */
export function describeActor(actor: Actor) {
  return {
    userId: actor.userId,
    role: actor.role,
    workspace: { id: actor.workspace.id, name: actor.workspace.name, slug: actor.workspace.slug },
  };
}

export async function listProjectsForPlugin(db: Db, actor: Actor): Promise<PluginProject[]> {
  assertCan(actor.role, 'project:read');
  const rows = await listProjects(db, actor);
  return rows.map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt.toISOString() }));
}

export async function listFramesForPlugin(
  db: Db,
  actor: Actor,
  projectId: string,
): Promise<{ projectId: string; version: number; frames: PluginFrame[] }> {
  assertCan(actor.role, 'project:read');
  const { version, doc } = await getDoc(db, actor, projectId);
  return {
    projectId,
    version,
    frames: doc.frames.map((f) => ({
      id: f.id,
      name: f.name,
      width: f.width,
      height: f.height,
      nodeCount: [...walk(doc, f.rootNodeId)].length,
    })),
  };
}
