/**
 * Figma integration services (Epic 8). Framework-free: `(db, actor, input)`, like every service.
 * The plugin reaches these through `/api/figma/plugin/**` (bearer plugin tokens); the web app
 * reaches them through server actions and `/api/figma/**` (Clerk session).
 */
import { assertCan } from '@crunch/authz';
import { and, eq, figmaLinks, type Db, type FigmaLinkRow } from '@crunch/db';
import { walk } from '@crunch/doc-model';
import { docToFigmaPlan, type PushPlan, type ReportItem } from '@crunch/figma-convert';
import type { z } from 'zod';
import { getDoc } from './design-docs';
import type { pushPlanRequest, pushResultRequest } from './figma/schemas';
import { resolveProjectDesignSystem } from './project-design-system';
import { getProject, listProjects } from './projects';
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

// ------------------------------------------------------------------ push (Story 8.2)

export interface PushLinkSummary {
  figmaFileKey: string;
  figmaFileName: string | null;
  lastSyncedAt: string | null;
  nodeCount: number;
  report: ReportItem[];
}

/**
 * Build the push plan for some (or all) frames of a project at one width. Pushing writes into
 * Figma on the user's behalf, so it needs design:edit, like the spec's other Figma actions.
 */
export async function buildPushPlan(
  db: Db,
  actor: Actor,
  projectId: string,
  input: z.infer<typeof pushPlanRequest>,
): Promise<PushPlan> {
  assertCan(actor.role, 'design:edit');
  const project = await getProject(db, actor, projectId);
  const [{ version, doc }, ds] = await Promise.all([
    getDoc(db, actor, projectId),
    resolveProjectDesignSystem(db, actor, project),
  ]);
  return docToFigmaPlan(doc, ds.spec, {
    projectId,
    docVersion: version,
    frameIds: input.frameIds,
    width: input.width,
    variables: input.variables,
  });
}

/** Record a completed push: the node map and mapping report, per project and Figma file. */
export async function recordPush(
  db: Db,
  actor: Actor,
  projectId: string,
  input: z.infer<typeof pushResultRequest>,
): Promise<PushLinkSummary> {
  assertCan(actor.role, 'design:edit');
  await getProject(db, actor, projectId);
  const now = new Date();
  const [existing] = await db
    .select()
    .from(figmaLinks)
    .where(
      and(
        eq(figmaLinks.projectId, projectId),
        eq(figmaLinks.figmaFileKey, input.fileKey),
        eq(figmaLinks.direction, 'push'),
      ),
    )
    .limit(1);
  // Merge: a push of some frames keeps the mapping of frames pushed earlier.
  const nodeMap = { ...((existing?.nodeMap as Record<string, string>) ?? {}), ...input.nodeMap };
  const lastReport = { docVersion: input.docVersion, items: input.report, at: now.toISOString() };
  const values = {
    figmaFileName: input.fileName ?? null,
    figmaPageId: input.pageId ?? null,
    nodeMap,
    lastReport,
    lastSyncedAt: now,
  };
  const [row] = await db
    .insert(figmaLinks)
    .values({
      workspaceId: actor.workspace.id,
      projectId,
      direction: 'push',
      figmaFileKey: input.fileKey,
      createdBy: actor.userId,
      ...values,
    })
    .onConflictDoUpdate({
      target: [figmaLinks.projectId, figmaLinks.figmaFileKey, figmaLinks.direction],
      set: values,
    })
    .returning();
  return toSummary(row!);
}

function toSummary(row: FigmaLinkRow): PushLinkSummary {
  const rep = row.lastReport as { items?: ReportItem[] } | null;
  return {
    figmaFileKey: row.figmaFileKey,
    figmaFileName: row.figmaFileName,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    nodeCount: Object.keys((row.nodeMap as Record<string, string>) ?? {}).length,
    report: rep?.items ?? [],
  };
}

/** Figma links of a project (for the editor: "pushed to …", last report). */
export async function listFigmaLinks(db: Db, actor: Actor, projectId: string) {
  assertCan(actor.role, 'project:read');
  await getProject(db, actor, projectId);
  const rows = await db
    .select()
    .from(figmaLinks)
    .where(
      and(eq(figmaLinks.projectId, projectId), eq(figmaLinks.workspaceId, actor.workspace.id)),
    );
  return rows.map((r) => ({ direction: r.direction, ...toSummary(r) }));
}
