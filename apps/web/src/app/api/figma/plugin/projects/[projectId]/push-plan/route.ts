/**
 * POST /api/figma/plugin/projects/:projectId/push-plan  (design:edit)
 *   <- { frameIds?, width?, variables? }
 *   -> PushPlan (frames, components, variables, mapping report) for the plugin to apply.
 */
import { buildPushPlan } from '@/server/services/figma';
import { pluginBody, pluginPreflight, pluginRoute } from '@/server/services/figma/plugin-http';
import { PUSH_PLAN_MAX_BYTES, pushPlanRequest } from '@/server/services/figma/schemas';

export const OPTIONS = pluginPreflight;
export const POST = pluginRoute<{ projectId: string }>(async ({ req, actor, db, params }) =>
  buildPushPlan(
    db,
    actor,
    params.projectId,
    await pluginBody(req, pushPlanRequest, PUSH_PLAN_MAX_BYTES),
  ),
);
