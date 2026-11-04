/**
 * Figma integration services (Epic 8). Framework-free: `(db, actor, input)`, like every service.
 * The plugin reaches these through `/api/figma/plugin/**` (bearer plugin tokens); the web app
 * reaches them through server actions and `/api/figma/**` (Clerk session).
 */
import { assertCan } from '@crunch/authz';
import type { Keyring } from '@crunch/crypto';
import { and, eq, figmaLinks, type Db, type FigmaLinkRow } from '@crunch/db';
import { newId, walk, type Frame, type Node } from '@crunch/doc-model';
import {
  checkImportLimits,
  collectImageRefs,
  collectSvgCandidates,
  collectVariableIds,
  docToFigmaPlan,
  figmaNode,
  figmaToDoc,
  importOps,
  type FigmaNode,
  type PushPlan,
  type ReportItem,
} from '@crunch/figma-convert';
import { sanitizeSvg } from '@crunch/renderer';
import { z } from 'zod';
import { commitTransaction, ConflictError, getDoc } from './design-docs';
import { loadFigmaToken } from './figma/credentials';
import { FigmaRest, parseFigmaUrl, type FigmaFetch } from './figma/rest';
import type { importRequest, pushPlanRequest, pushResultRequest } from './figma/schemas';
import { resolveProjectDesignSystem } from './project-design-system';
import { getProject, listProjects } from './projects';
import { ValidationError, type Actor } from './types';

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

// ------------------------------------------------------------------ import (Story 8.3)

export type ImportInput = z.input<typeof importRequest> & { source: 'plugin' | 'rest' };

export interface ImportResult {
  version: number | null;
  frames: { id: string; name: string; width: number }[];
  report: ReportItem[];
  stats: { nodes: number; tokens: number; svgs: number; images: number };
  /** Only for dry runs: the converted frames (e.g. as agent prompt reference, Story 5.6). */
  preview?: { frame: Frame; nodes: Node[] }[];
}

const nodesSchema = z.array(figmaNode).min(1).max(20);
const MAX_COMMIT_ATTEMPTS = 3;

/**
 * Convert Figma nodes (REST or plugin-serialized) and insert them as new frames in one
 * transaction (source 'import'), placed to the right of the existing frames. One-shot: imports
 * are never linked back for live sync (SPEC D12).
 */
export async function importFigmaNodes(
  db: Db,
  actor: Actor,
  projectId: string,
  input: ImportInput,
  opts: { dryRun?: boolean } = {},
): Promise<ImportResult> {
  assertCan(actor.role, opts.dryRun ? 'project:read' : 'design:edit');
  const parsed = nodesSchema.safeParse(input.nodes);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw new ValidationError(
      `Invalid Figma nodes: ${i ? `${i.path.join('.')}: ${i.message}` : 'invalid'}`,
    );
  }
  const roots: FigmaNode[] = parsed.data;
  try {
    checkImportLimits(roots);
  } catch (e) {
    throw new ValidationError(e instanceof Error ? e.message : 'Import too large');
  }
  const project = await getProject(db, actor, projectId);
  const ds = await resolveProjectDesignSystem(db, actor, project);
  const svgs: Record<string, string> = {};
  for (const [id, svg] of Object.entries(input.svgs ?? {})) svgs[id] = sanitizeSvg(svg);

  for (let attempt = 1; ; attempt++) {
    const { version, doc } = await getDoc(db, actor, projectId);
    const right = doc.frames.reduce((m, f) => Math.max(m, f.canvas.x + f.width), -200);
    const result = figmaToDoc(roots, {
      svgs,
      images: input.images ?? {},
      variables: input.variables ?? {},
      designSystem: ds.spec,
      origin: { x: right + 200, y: 0 },
    });
    if (!result.frames.length) throw new ValidationError('Nothing to import');
    const summary = {
      frames: result.frames.map((f) => ({
        id: f.frame.id,
        name: f.frame.name,
        width: f.frame.width,
      })),
      report: result.report,
      stats: result.stats,
    };
    if (opts.dryRun) return { version: null, ...summary, preview: result.frames };
    try {
      const commit = await commitTransaction(db, actor, projectId, {
        baseVersion: version,
        txn: {
          id: newId('c'),
          source: 'import',
          label: `Import from Figma${input.fileName ? `: ${input.fileName.slice(0, 120)}` : ''}`,
          ops: importOps(result, doc.frames.length),
        },
      });
      if (input.fileKey) await recordImport(db, actor, projectId, input, roots, summary);
      return { version: commit.version, ...summary };
    } catch (e) {
      // Someone edited meanwhile: rebuild against the new version (ids are regenerated).
      if (e instanceof ConflictError && attempt < MAX_COMMIT_ATTEMPTS) continue;
      throw e;
    }
  }
}

async function recordImport(
  db: Db,
  actor: Actor,
  projectId: string,
  input: ImportInput,
  roots: FigmaNode[],
  summary: Pick<ImportResult, 'frames' | 'report' | 'stats'>,
) {
  const nodeMap = Object.fromEntries(summary.frames.map((f, i) => [f.id, roots[i]?.id ?? '']));
  const values = {
    figmaFileName: input.fileName ?? null,
    nodeMap,
    lastReport: {
      items: summary.report,
      stats: summary.stats,
      source: input.source,
      at: new Date().toISOString(),
    },
    lastSyncedAt: new Date(),
  };
  await db
    .insert(figmaLinks)
    .values({
      workspaceId: actor.workspace.id,
      projectId,
      direction: 'import',
      figmaFileKey: input.fileKey!,
      createdBy: actor.userId,
      ...values,
    })
    .onConflictDoUpdate({
      target: [figmaLinks.projectId, figmaLinks.figmaFileKey, figmaLinks.direction],
      set: values,
    });
}

export interface ImportUrlDeps {
  fetch?: FigmaFetch;
  keyring?: Keyring;
}

/** Import from a figma.com file/frame URL with the caller's Figma token (REST). */
export async function importFigmaUrl(
  db: Db,
  actor: Actor,
  projectId: string,
  url: string,
  deps: ImportUrlDeps & { dryRun?: boolean } = {},
): Promise<ImportResult> {
  assertCan(actor.role, deps.dryRun ? 'project:read' : 'design:edit');
  const { fileKey, nodeIds } = parseFigmaUrl(url);
  await getProject(db, actor, projectId);
  const rest = new FigmaRest(await loadFigmaToken(db, actor, deps.keyring), deps.fetch);
  let ids = nodeIds;
  let fileName: string | undefined;
  if (!ids.length) {
    const top = await rest.topFrameIds(fileKey);
    ids = top.ids;
    fileName = top.name;
  }
  if (!ids.length) throw new ValidationError('No frames found in that file');
  const { name, documents } = await rest.nodes(fileKey, ids);
  const parsed = nodesSchema.safeParse(documents);
  if (!parsed.success) throw new ValidationError('Figma returned nodes we could not read');
  const [svgs, images, variables] = await Promise.all([
    rest.svgs(fileKey, collectSvgCandidates(parsed.data)),
    collectImageRefs(parsed.data).length ? rest.imageFills(fileKey) : Promise.resolve({}),
    collectVariableIds(parsed.data).length ? rest.variableNames(fileKey) : Promise.resolve({}),
  ]);
  const result = await importFigmaNodes(
    db,
    actor,
    projectId,
    {
      fileKey,
      fileName: fileName ?? name,
      nodes: parsed.data,
      svgs,
      images,
      variables: variables ?? {},
      source: 'rest',
    },
    { dryRun: deps.dryRun },
  );
  const extra: ReportItem[] = [];
  if (Object.keys(images).length)
    extra.push({
      severity: 'warning',
      subject: 'images',
      message: 'Figma image URLs expire after about 14 days; replace them with hosted assets',
    });
  if (variables === null && collectVariableIds(parsed.data).length)
    extra.push({
      severity: 'info',
      subject: 'variables',
      message:
        'Variables are only readable over REST on Enterprise plans; import from the plugin to map variables to tokens',
    });
  return { ...result, report: [...extra, ...result.report] };
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
