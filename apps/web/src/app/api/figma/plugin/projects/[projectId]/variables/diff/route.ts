/**
 * POST /api/figma/plugin/projects/:projectId/variables/diff  (design_system:read)
 *   <- { fileKey, direction: 'pull'|'push', snapshot }
 *   -> { direction, entries, summary, hasBase, collection, designSystem, report }
 */
import { pluginBody, pluginPreflight, pluginRoute } from '@/server/services/figma/plugin-http';
import { SYNC_MAX_BYTES, syncRequest } from '@/server/services/figma/schemas';
import { diffVariables } from '@/server/services/figma/token-sync';

export const OPTIONS = pluginPreflight;
export const POST = pluginRoute<{ projectId: string }>(async ({ req, actor, db, params }) =>
  diffVariables(db, actor, params.projectId, await pluginBody(req, syncRequest, SYNC_MAX_BYTES)),
);
