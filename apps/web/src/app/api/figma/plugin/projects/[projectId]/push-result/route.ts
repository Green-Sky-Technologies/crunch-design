/**
 * POST /api/figma/plugin/projects/:projectId/push-result  (design:edit)
 *   <- { fileKey, fileName?, pageId?, docVersion, nodeMap, report }
 *   -> { figmaFileKey, nodeCount, lastSyncedAt, report }
 * Records which Figma nodes a push produced (mirrors the NodeIds stored in Figma plugin data).
 */
import { recordPush } from '@/server/services/figma';
import { pluginBody, pluginPreflight, pluginRoute } from '@/server/services/figma/plugin-http';
import { PUSH_RESULT_MAX_BYTES, pushResultRequest } from '@/server/services/figma/schemas';

export const OPTIONS = pluginPreflight;
export const POST = pluginRoute<{ projectId: string }>(async ({ req, actor, db, params }) =>
  recordPush(
    db,
    actor,
    params.projectId,
    await pluginBody(req, pushResultRequest, PUSH_RESULT_MAX_BYTES),
  ),
);
