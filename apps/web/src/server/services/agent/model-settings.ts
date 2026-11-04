/** Workspace model defaults and allowed models (Story 5.9), stored in workspace_agent_settings. */
import { DEFAULT_MODEL_SETTINGS, isKnownModel, type WorkspaceModelSettings } from '@crunch/agent';
import { eq, workspaceAgentSettings, type Db } from '@crunch/db';

export async function getModelSettings(
  db: Db,
  workspaceId: string,
): Promise<WorkspaceModelSettings> {
  const [row] = await db
    .select()
    .from(workspaceAgentSettings)
    .where(eq(workspaceAgentSettings.workspaceId, workspaceId))
    .limit(1);
  if (!row) return DEFAULT_MODEL_SETTINGS;
  const defaults = (row.modelDefaults ?? {}) as Record<string, unknown>;
  const modelDefaults: WorkspaceModelSettings['modelDefaults'] = {};
  for (const tier of ['generation', 'interactive', 'utility'] as const) {
    const v = defaults[tier];
    if (typeof v === 'string' && isKnownModel(v)) modelDefaults[tier] = v;
  }
  return {
    modelDefaults,
    allowedModels: row.allowedModels ? row.allowedModels.filter(isKnownModel) : null,
  };
}
