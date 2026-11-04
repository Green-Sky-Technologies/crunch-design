/** GET /api/figma/plugin/me -> who the plugin token acts as (workspace, user, role). */
import { describeActor } from '@/server/services/figma';
import { pluginPreflight, pluginRoute } from '@/server/services/figma/plugin-http';

export const OPTIONS = pluginPreflight;
export const GET = pluginRoute(async ({ actor }) => describeActor(actor));
