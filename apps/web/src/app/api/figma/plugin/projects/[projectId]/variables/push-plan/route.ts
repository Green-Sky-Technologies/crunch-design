/**
 * POST /api/figma/plugin/projects/:projectId/variables/push-plan  (design_system:edit)
 *   <- { fileKey, snapshot, selected, resolutions }
 *   -> { variables: VariablesSpec, remove: tokenPath[] }   applied by the plugin
 */
import { pluginBody, pluginPreflight, pluginRoute } from '@/server/services/figma/plugin-http';
import { SYNC_MAX_BYTES, syncRequest } from '@/server/services/figma/schemas';
import { planVariablesPush } from '@/server/services/figma/token-sync';

export const OPTIONS = pluginPreflight;
export const POST = pluginRoute<{ projectId: string }>(async ({ req, actor, db, params }) =>
  planVariablesPush(
    db,
    actor,
    params.projectId,
    await pluginBody(req, syncRequest, SYNC_MAX_BYTES),
  ),
);
