/**
 * POST /api/figma/plugin/projects/:projectId/import  (design:edit)
 *   <- { fileKey?, fileName?, nodes, svgs, images, variables }  (nodes serialized by the plugin)
 *   -> { version, frames, report, stats }
 */
import { importFigmaNodes } from '@/server/services/figma';
import { pluginBody, pluginPreflight, pluginRoute } from '@/server/services/figma/plugin-http';
import { IMPORT_MAX_BYTES, importRequest } from '@/server/services/figma/schemas';

export const OPTIONS = pluginPreflight;
export const POST = pluginRoute<{ projectId: string }>(async ({ req, actor, db, params }) => {
  const body = await pluginBody(req, importRequest, IMPORT_MAX_BYTES);
  return importFigmaNodes(db, actor, params.projectId, { ...body, source: 'plugin' });
});
