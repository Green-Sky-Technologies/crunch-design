/** GET /api/figma/plugin/projects -> the workspace's active projects (project:read). */
import { listProjectsForPlugin } from '@/server/services/figma';
import { pluginPreflight, pluginRoute } from '@/server/services/figma/plugin-http';

export const OPTIONS = pluginPreflight;
export const GET = pluginRoute(async ({ actor, db }) => ({
  projects: await listProjectsForPlugin(db, actor),
}));
