/** GET /api/figma/plugin/projects/:projectId/frames -> { projectId, version, frames } (project:read). */
import { listFramesForPlugin } from '@/server/services/figma';
import { pluginPreflight, pluginRoute } from '@/server/services/figma/plugin-http';

export const OPTIONS = pluginPreflight;
export const GET = pluginRoute<{ projectId: string }>(async ({ actor, db, params }) =>
  listFramesForPlugin(db, actor, params.projectId),
);
