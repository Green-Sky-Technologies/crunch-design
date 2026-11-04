/**
 * POST /api/figma/plugin/projects/:projectId/variables/push-result  (design_system:edit)
 *   <- { fileKey, snapshot }   the file's variables after the plugin applied a push
 *   -> { synced }              records the new sync base
 */
import { pluginBody, pluginPreflight, pluginRoute } from '@/server/services/figma/plugin-http';
import { SYNC_MAX_BYTES, syncResultRequest } from '@/server/services/figma/schemas';
import { recordVariablesPush } from '@/server/services/figma/token-sync';

export const OPTIONS = pluginPreflight;
export const POST = pluginRoute<{ projectId: string }>(async ({ req, actor, db, params }) =>
  recordVariablesPush(
    db,
    actor,
    params.projectId,
    await pluginBody(req, syncResultRequest, SYNC_MAX_BYTES),
  ),
);
