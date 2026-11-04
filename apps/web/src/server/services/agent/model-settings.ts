/** Workspace model defaults and allowed models (Story 5.9), stored in workspace_agent_settings. */
import { assertCan } from '@crunch/authz';
import {
  DEFAULT_MODEL_SETTINGS,
  formatRelativeCost,
  isKnownModel,
  MODEL_TIERS,
  MODELS,
  relativeCost,
  resolveModel,
  type ModelTier,
  type WorkspaceModelSettings,
} from '@crunch/agent';
import { eq, workspaceAgentSettings, type Db } from '@crunch/db';
import { z } from 'zod';
import { ValidationError, type Actor } from '../types';

const TIERS = ['generation', 'interactive', 'utility'] as const satisfies readonly ModelTier[];

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
  for (const tier of TIERS) {
    const v = defaults[tier];
    if (typeof v === 'string' && isKnownModel(v)) modelDefaults[tier] = v;
  }
  return {
    modelDefaults,
    allowedModels: row.allowedModels ? row.allowedModels.filter(isKnownModel) : null,
  };
}

export interface ModelOption {
  id: string;
  label: string;
  tier: string;
  /** Cost relative to the interactive default (output-price based). */
  relativeCost: number;
  relativeCostLabel: string;
  allowed: boolean;
}

export interface AgentSettingsView {
  models: ModelOption[];
  /** Effective default per tier (after admin overrides and the allowed list). */
  defaults: Record<ModelTier, string | null>;
  /** Admin overrides as stored. */
  overrides: Partial<Record<ModelTier, string>>;
  allowedModels: string[] | null;
  tierDefaults: typeof MODEL_TIERS;
  canManage: boolean;
}

const TASK_FOR_TIER = {
  generation: 'generation',
  interactive: 'interactive',
  utility: 'utility',
} as const;

export async function getAgentSettings(db: Db, actor: Actor): Promise<AgentSettingsView> {
  assertCan(actor.role, 'workspace:read');
  const s = await getModelSettings(db, actor.workspace.id);
  const defaults = {} as Record<ModelTier, string | null>;
  for (const tier of TIERS) {
    try {
      defaults[tier] = resolveModel(s, TASK_FOR_TIER[tier]);
    } catch {
      defaults[tier] = null;
    }
  }
  return {
    models: MODELS.map((m) => ({
      id: m.id,
      label: m.label,
      tier: m.tier,
      relativeCost: relativeCost(m.id),
      relativeCostLabel: formatRelativeCost(m.id),
      allowed: s.allowedModels === null || s.allowedModels.includes(m.id),
    })),
    defaults,
    overrides: s.modelDefaults,
    allowedModels: s.allowedModels,
    tierDefaults: MODEL_TIERS,
    canManage: actor.role === 'admin',
  };
}

const knownModel = z.string().refine(isKnownModel, 'Unknown model');

export const updateModelSettingsInput = z
  .object({
    modelDefaults: z
      .object({
        generation: knownModel.nullish(),
        interactive: knownModel.nullish(),
        utility: knownModel.nullish(),
      })
      .strict(),
    /** null = allow every model. */
    allowedModels: z.array(knownModel).min(1).max(50).nullable(),
  })
  .strict();

export async function updateModelSettings(
  db: Db,
  actor: Actor,
  raw: unknown,
): Promise<AgentSettingsView> {
  // Admin-only, like credentials: these choices spend the workspace key.
  assertCan(actor.role, 'workspace:manage_credentials');
  const parsed = updateModelSettingsInput.safeParse(raw);
  if (!parsed.success)
    throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid settings');
  const { allowedModels } = parsed.data;
  const modelDefaults: Partial<Record<ModelTier, string>> = {};
  for (const tier of TIERS) {
    const v = parsed.data.modelDefaults[tier];
    if (!v) continue;
    if (allowedModels && !allowedModels.includes(v))
      throw new ValidationError(`The ${tier} default must be one of the allowed models`, {
        [tier]: ['Not in the allowed list'],
      });
    modelDefaults[tier] = v;
  }
  const values = { modelDefaults, allowedModels, updatedBy: actor.userId };
  await db
    .insert(workspaceAgentSettings)
    .values({ workspaceId: actor.workspace.id, ...values })
    .onConflictDoUpdate({ target: workspaceAgentSettings.workspaceId, set: values });
  return getAgentSettings(db, actor);
}
