/**
 * Deterministic exports (Epic 7, no LLM): standalone HTML and ZIP (7.1) and the handoff
 * bundle (7.2: handoff.json, or a ZIP with handoff.json + schema + reference HTML).
 * Needs export:deterministic, which Viewers have (SPEC §3, D17). Reads are workspace-scoped.
 */
import { assertCan } from '@crunch/authz';
import { agentConversations, and, desc, eq, type Db } from '@crunch/db';
import type { DesignDoc } from '@crunch/doc-model';
import type { HandoffBundle } from '@crunch/contracts';
import {
  buildExportZip,
  buildHandoffBundle,
  ExportError,
  exportHtml,
  HANDOFF_README,
  handoffJsonSchema,
  slugify,
  type AssetFetcher,
} from '@crunch/handoff';
import { z } from 'zod';
import { recordActivity } from './activity';
import { getDoc } from './design-docs';
import { resolveProjectDesignSystem, type ResolvedDesignSystem } from './project-design-system';
import { getProject } from './projects';
import { getSnapshotDoc, listSnapshots } from './snapshots';
import { ValidationError, type Actor } from './types';

export const EXPORT_FORMATS = ['html', 'zip', 'handoff', 'handoff-zip'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const exportInput = z
  .object({
    format: z.enum(EXPORT_FORMATS),
    frameIds: z.array(z.string().max(64)).min(1).max(200).optional(),
    versionId: z.uuid().optional(),
  })
  .strict();

export interface ExportFile {
  filename: string;
  contentType: string;
  body: string | Uint8Array;
  warnings: string[];
}

export interface ExportSource {
  project: { id: string; name: string; description: string | null };
  doc: DesignDoc;
  designSystem: ResolvedDesignSystem;
  versionId: string | null;
}

/** Load what an export renders: the live doc or a saved version, plus the project's design system. */
export async function loadExportSource(
  db: Db,
  actor: Actor,
  projectId: string,
  versionId?: string,
): Promise<ExportSource> {
  assertCan(actor.role, 'export:deterministic');
  const project = await getProject(db, actor, projectId);
  const doc = versionId
    ? (await getSnapshotDoc(db, actor, project.id, versionId)).doc
    : (await getDoc(db, actor, project.id)).doc;
  const designSystem = await resolveProjectDesignSystem(db, actor, project);
  return {
    project: { id: project.id, name: project.name, description: project.description },
    doc,
    designSystem,
    versionId: versionId ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// Asset fetching for offline ZIPs: only our own blob storage, https, bounded size and time.
// ---------------------------------------------------------------------------------------------

const ALLOWED_ASSET_HOST = /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;

export function isBundlableAssetUrl(src: string): boolean {
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return false;
  }
  return (
    u.protocol === 'https:' &&
    !u.username &&
    !u.password &&
    (u.port === '' || u.port === '443') &&
    ALLOWED_ASSET_HOST.test(u.hostname)
  );
}

export function blobAssetFetcher(fetchImpl: typeof fetch = fetch): AssetFetcher {
  return async (src) => {
    if (!isBundlableAssetUrl(src)) return null; // SSRF guard: never fetch arbitrary hosts
    const res = await fetchImpl(src, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) return null;
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_ASSET_BYTES) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_ASSET_BYTES) return null;
    return { bytes, contentType: type };
  };
}

/** Build the handoff bundle (Story 7.2) for the live doc or a saved version. */
export async function buildProjectHandoff(
  db: Db,
  actor: Actor,
  projectId: string,
  opts: { frameIds?: string[]; versionId?: string; source?: ExportSource } = {},
): Promise<HandoffBundle> {
  const src = opts.source ?? (await loadExportSource(db, actor, projectId, opts.versionId));
  const [versions, conversations] = await Promise.all([
    listSnapshots(db, actor, src.project.id, { kind: 'named', limit: 50 }),
    db
      .select({ title: agentConversations.title })
      .from(agentConversations)
      .where(
        and(
          eq(agentConversations.projectId, src.project.id),
          eq(agentConversations.workspaceId, actor.workspace.id),
        ),
      )
      .orderBy(desc(agentConversations.updatedAt))
      .limit(50),
  ]);
  try {
    return buildHandoffBundle({
      project: src.project,
      doc: src.doc,
      designSystem: { spec: src.designSystem.spec, version: src.designSystem.version },
      frameIds: opts.frameIds,
      intent: {
        projectName: src.project.name,
        projectDescription: src.project.description,
        versions: versions.map((v) => ({ name: v.name, description: v.description })),
        conversationTitles: conversations.map((c) => c.title),
      },
    });
  } catch (e) {
    if (e instanceof ExportError) throw new ValidationError(e.message);
    throw e;
  }
}

function parseInput(input: unknown) {
  const r = exportInput.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? 'Invalid export request');
  return r.data;
}

export async function exportDesign(
  db: Db,
  actor: Actor,
  projectId: string,
  input: unknown,
  deps: { fetchAsset?: AssetFetcher } = {},
): Promise<ExportFile> {
  assertCan(actor.role, 'export:deterministic');
  const req = parseInput(input);
  const src = await loadExportSource(db, actor, projectId, req.versionId);
  const base = slugify(src.project.name, 'design');
  const title = src.project.name;
  let file: ExportFile;
  try {
    if (req.format === 'html') {
      const r = exportHtml(src.doc, src.designSystem.spec, { frameIds: req.frameIds, title });
      file = {
        filename: `${base}.html`,
        contentType: 'text/html; charset=utf-8',
        body: r.html,
        warnings: r.warnings,
      };
    } else if (req.format === 'handoff') {
      const bundle = await buildProjectHandoff(db, actor, projectId, {
        frameIds: req.frameIds,
        source: src,
      });
      file = {
        filename: `${base}.handoff.json`,
        contentType: 'application/json; charset=utf-8',
        body: `${JSON.stringify(bundle, null, 2)}\n`,
        warnings: [],
      };
    } else {
      const extraFiles: Record<string, string> = {};
      if (req.format === 'handoff-zip') {
        const bundle = await buildProjectHandoff(db, actor, projectId, {
          frameIds: req.frameIds,
          source: src,
        });
        extraFiles['handoff.json'] = `${JSON.stringify(bundle, null, 2)}\n`;
        extraFiles['handoff.schema.json'] = `${JSON.stringify(handoffJsonSchema(), null, 2)}\n`;
        extraFiles['HANDOFF.md'] = HANDOFF_README;
      }
      const r = await buildExportZip(src.doc, src.designSystem.spec, {
        frameIds: req.frameIds,
        title,
        fetchAsset: deps.fetchAsset ?? blobAssetFetcher(),
        extraFiles,
      });
      file = {
        filename: req.format === 'handoff-zip' ? `${base}-handoff.zip` : `${base}.zip`,
        contentType: 'application/zip',
        body: r.zip,
        warnings: r.warnings,
      };
    }
  } catch (e) {
    if (e instanceof ExportError) throw new ValidationError(e.message);
    throw e;
  }
  await recordActivity(db, actor, {
    projectId: src.project.id,
    verb: 'export.created',
    targetType: 'export',
    data: { format: req.format, versionId: src.versionId, frames: req.frameIds?.length ?? null },
  });
  return file;
}
