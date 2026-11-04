/**
 * POST /api/figma/plugin/projects/:projectId/variables/pull  (design_system:edit)
 *   <- { fileKey, snapshot, selected, resolutions }
 *   -> { applied, designSystem, patch, spec, message }
 * 400 with fieldErrors.conflicts when a selected conflict has no resolution.
 */
import { pluginBody, pluginPreflight, pluginRoute } from '@/server/services/figma/plugin-http';
import { SYNC_MAX_BYTES, syncRequest } from '@/server/services/figma/schemas';
import { designSystemDraftWriter } from '@/server/services/figma/ds-draft-writer';
import { pullVariables } from '@/server/services/figma/token-sync';

export const OPTIONS = pluginPreflight;
export const POST = pluginRoute<{ projectId: string }>(async ({ req, actor, db, params }) =>
  pullVariables(db, actor, params.projectId, await pluginBody(req, syncRequest, SYNC_MAX_BYTES), {
    writeDraft: designSystemDraftWriter,
  }),
);
