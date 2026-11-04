/**
 * Model catalog, prices and task-based defaults (SPEC §2, Stories 5.9, 5.10).
 *
 * Server-side (imports @crunch/providers). The browser gets the catalog from /api/agent/settings.
 *
 * Prices are Anthropic first-party list prices in USD per million tokens, taken from
 * Anthropic's pricing documentation (checked 2026-10-06). Bedrock and Vertex bill at partner
 * rates, so costs on those routes are estimates. Re-check before relying on reconciliation
 * (Story 5.10 AC: within ±5% of provider usage).
 */
import { MODEL_TIERS, type ModelTier } from '@crunch/providers';

export { MODEL_TIERS, type ModelTier };

export interface ModelPrice {
  /** USD per million input tokens (uncached). */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** USD per million cache-read tokens. */
  cacheRead: number;
}

export interface ModelInfo {
  id: string;
  label: string;
  tier: ModelTier | 'premium';
  price: ModelPrice;
}

/** Cache-write multipliers on the input price, by TTL. */
export const CACHE_WRITE_MULTIPLIER = { '5m': 1.25, '1h': 2 } as const;

export const MODELS: readonly ModelInfo[] = [
  {
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    tier: 'utility',
    price: { input: 0.1, output: 0.5, cacheRead: 0.01 },
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    tier: 'interactive',
    price: { input: 2, output: 10, cacheRead: 0.2 },
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    tier: 'interactive',
    price: { input: 2, output: 10, cacheRead: 0.2 },
  },
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    tier: 'generation',
    price: { input: 4, output: 20, cacheRead: 0.2 },
  },
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    tier: 'generation',
    price: { input: 5, output: 25, cacheRead: 0.5 },
  },
  {
    id: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    tier: 'premium',
    price: { input: 10, output: 50, cacheRead: 0.25 },
  },
];

const BY_ID = new Map(MODELS.map((m) => [m.id, m]));

/** Strip provider prefixes (Bedrock's `anthropic.`) to get the first-party id. */
export function baseModelId(model: string): string {
  return model.replace(/^(?:[a-z]{2}\.)?anthropic\./, '');
}

export function modelInfo(model: string): ModelInfo | undefined {
  return BY_ID.get(baseModelId(model));
}

export const isKnownModel = (model: string) => BY_ID.has(baseModelId(model));

/** Cost relative to the interactive default, by output price (output dominates cost, SPEC §2). */
export function relativeCost(model: string): number {
  const base = BY_ID.get(MODEL_TIERS.interactive)!.price.output;
  const m = modelInfo(model);
  return m ? m.price.output / base : 1;
}

export function formatRelativeCost(model: string): string {
  const r = relativeCost(model);
  return `${r < 1 ? r.toFixed(2).replace(/0$/, '') : Number.isInteger(r) ? r : r.toFixed(1)}×`;
}

/** What a call is for; mirrors the llm_task DB enum. */
export const LLM_TASKS = [
  'generation',
  'interactive',
  'utility',
  'codegen',
  'import',
  'lint',
  'test',
] as const;
export type LlmTask = (typeof LLM_TASKS)[number];

/** Which tier a task defaults to (SPEC §2.6). */
export const TASK_TIER: Record<LlmTask, ModelTier> = {
  generation: 'generation',
  codegen: 'generation',
  import: 'generation',
  interactive: 'interactive',
  utility: 'utility',
  lint: 'utility',
  test: 'utility',
};

export interface WorkspaceModelSettings {
  /** Admin overrides of the default model per tier. */
  modelDefaults: Partial<Record<ModelTier, string>>;
  /** Allowed model ids; null = every known model. */
  allowedModels: string[] | null;
}

export const DEFAULT_MODEL_SETTINGS: WorkspaceModelSettings = {
  modelDefaults: {},
  allowedModels: null,
};

export function isModelAllowed(settings: WorkspaceModelSettings, model: string): boolean {
  const id = baseModelId(model);
  if (!BY_ID.has(id)) return false;
  return settings.allowedModels === null || settings.allowedModels.includes(id);
}

export function allowedModels(settings: WorkspaceModelSettings): ModelInfo[] {
  return MODELS.filter((m) => isModelAllowed(settings, m.id));
}

export class ModelNotAllowedError extends Error {
  override name = 'ModelNotAllowedError';
  constructor(public readonly model: string) {
    super(`Model ${model} isn't allowed in this workspace`);
  }
}

/**
 * Pick the model for a call: the per-prompt override if allowed, else the workspace default for
 * the task's tier, else MODEL_TIERS. Falls back to the cheapest allowed model if the default is
 * disallowed. Throws if an explicit override is not allowed.
 */
export function resolveModel(
  settings: WorkspaceModelSettings,
  task: LlmTask,
  override?: string | null,
): string {
  if (override) {
    if (!isModelAllowed(settings, override)) throw new ModelNotAllowedError(override);
    return baseModelId(override);
  }
  const tier = TASK_TIER[task];
  for (const candidate of [settings.modelDefaults[tier], MODEL_TIERS[tier]]) {
    if (candidate && isModelAllowed(settings, candidate)) return baseModelId(candidate);
  }
  const allowed = allowedModels(settings).sort((a, b) => a.price.output - b.price.output);
  if (!allowed[0]) throw new ModelNotAllowedError(MODEL_TIERS[tier]);
  return allowed[0].id;
}
