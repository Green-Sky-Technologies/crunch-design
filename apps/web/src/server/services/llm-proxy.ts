/**
 * LLM proxy (Story 5.2): every model call, interactive or from a sandbox, goes through here.
 *
 * - Resolves the workspace credential server-side via loadWorkspaceClient (the only path to
 *   decrypted material) and routes to the workspace's provider (Anthropic/Bedrock/Vertex/Foundry).
 * - Enforces the workspace's allowed models and maps ids per provider (providerModelId).
 * - Calls the budget hook (a no-op in beta, SPEC D18) before spending.
 * - Records every call in llm_calls: tokens in/out, cache read/write, latency, estimated cost, task.
 *
 * Sandboxes reach this through /api/llm/v1/messages with a job token (never a real key).
 * The interactive agent calls `streamModel` in-process.
 */
import {
  Anthropic,
  emptyUsage,
  encodeSse,
  estimateCostMicros,
  isModelAllowed,
  mergeUsage,
  modelInfo,
  baseModelId,
  sseStream,
  SSE_HEADERS,
  usageFromEvent,
  type LlmTask,
  type UsageTotals,
} from '@crunch/agent';
import type { JobKind } from '@crunch/contracts';
import { llmCalls, type Db, type JobRow } from '@crunch/db';
import { providerModelId, type Provider } from '@crunch/providers';
import { z } from 'zod';
import { JobTokenError, tokenFromHeaders, verifyJobToken } from './agent/job-tokens';
import { getModelSettings } from './agent/model-settings';
import { HEARTBEAT_THROTTLE_MS, touchJobHeartbeat } from './jobs';
import { loadWorkspaceClient } from './credentials';
import { NotFoundError, ValidationError } from './types';

// ---------------------------------------------------------------------------------------------
// Types and seams
// ---------------------------------------------------------------------------------------------

export interface LlmCallContext {
  workspaceId: string;
  task: LlmTask;
  userId?: string | null;
  projectId?: string | null;
  jobId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
}

export type MessageStreamParams = Omit<Anthropic.MessageCreateParamsStreaming, 'stream'>;

/** What we need from an SDK message stream (Anthropic.MessageStream satisfies it). */
export interface ModelStream extends AsyncIterable<Anthropic.RawMessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Message>;
}

/** The subset of `client.messages` the proxy uses. Every provider client exposes it. */
export interface MessagesApi {
  stream(
    body: Anthropic.MessageStreamParams,
    opts?: { signal?: AbortSignal; headers?: Record<string, string> },
  ): ModelStream;
  countTokens(
    body: Anthropic.MessageCountTokensParams,
    opts?: { signal?: AbortSignal; headers?: Record<string, string> },
  ): Promise<Anthropic.MessageTokensCount>;
}

export interface BudgetDecision {
  allowed: boolean;
  reason?: string;
}

/** Spend-cap seam (SPEC §3: no caps in beta, metering only). */
export interface BudgetHook {
  check(ctx: LlmCallContext & { model: string }): Promise<BudgetDecision>;
}

export const noopBudgetHook: BudgetHook = { check: async () => ({ allowed: true }) };

export interface LlmProxyDeps {
  /** Override for tests: return a client for the workspace without decrypting anything. */
  loadClient?: (
    db: Db,
    workspaceId: string,
  ) => Promise<{ messages: MessagesApi; provider: Provider }>;
  budget?: BudgetHook;
  now?: () => number;
}

export class BudgetExceededError extends Error {
  override name = 'BudgetExceededError';
}

/** Provider-side failure, with a status safe to surface (no credential material). */
export class ProviderError extends Error {
  override name = 'ProviderError';
  constructor(
    message: string,
    public readonly status: number,
    public readonly errorType: string,
  ) {
    super(message);
  }
}

async function defaultLoadClient(db: Db, workspaceId: string) {
  const { client, config } = await loadWorkspaceClient(db, workspaceId, {
    sessionName: `crunch-llm-${workspaceId}`,
  });
  return { messages: client.messages as unknown as MessagesApi, provider: config.provider };
}

function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : 502;
    const body = err.error as { error?: { type?: string } } | undefined;
    const type = body?.error?.type ?? err.name;
    // Provider messages can echo request details; keep only the status and error type.
    return new ProviderError(`Model provider returned HTTP ${status} (${type})`, status, type);
  }
  if (err instanceof Error && err.name === 'AbortError')
    return new ProviderError('Request aborted', 499, 'aborted');
  return new ProviderError('Model provider request failed', 502, 'connection_error');
}

// ---------------------------------------------------------------------------------------------
// Core: one metered, streamed model call
// ---------------------------------------------------------------------------------------------

export interface StreamModelOptions {
  signal?: AbortSignal;
  /** Receives every raw stream event (to forward as SSE or update the UI). */
  onEvent?: (e: Anthropic.RawMessageStreamEvent) => void | Promise<void>;
  /** Forwarded request headers (only `anthropic-beta` is passed through). */
  headers?: Record<string, string>;
}

interface PreparedCall {
  model: string;
  provider: Provider;
  messages: MessagesApi;
}

/** Validate the model, check the budget and resolve the provider client. No tokens spent yet. */
async function prepareCall(
  db: Db,
  ctx: LlmCallContext,
  requestedModel: string,
  deps: LlmProxyDeps,
): Promise<PreparedCall> {
  const model = baseModelId(requestedModel);
  const settings = await getModelSettings(db, ctx.workspaceId);
  if (!modelInfo(model)) throw new ValidationError(`Unknown model: ${requestedModel}`);
  if (!isModelAllowed(settings, model))
    throw new ValidationError(`Model ${model} isn't allowed in this workspace`);
  const decision = await (deps.budget ?? noopBudgetHook).check({ ...ctx, model });
  if (!decision.allowed) throw new BudgetExceededError(decision.reason ?? 'Budget exceeded');
  const { messages, provider } = await (deps.loadClient ?? defaultLoadClient)(db, ctx.workspaceId);
  return { model, provider, messages };
}

async function recordCall(
  db: Db,
  ctx: LlmCallContext,
  call: { model: string; provider: Provider },
  usage: UsageTotals,
  meta: { latencyMs: number; ok: boolean; errorType?: string | null; requestId?: string | null },
) {
  await db.insert(llmCalls).values({
    workspaceId: ctx.workspaceId,
    userId: ctx.userId ?? null,
    projectId: ctx.projectId ?? null,
    jobId: ctx.jobId ?? null,
    conversationId: ctx.conversationId ?? null,
    messageId: ctx.messageId ?? null,
    task: ctx.task,
    provider: call.provider,
    model: call.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    latencyMs: meta.latencyMs,
    estCostMicros: estimateCostMicros(call.model, usage),
    stopReason: usage.stopReason,
    ok: meta.ok,
    errorType: meta.errorType ?? null,
    requestId: meta.requestId ?? null,
  });
}

/**
 * Betas a sandbox may enable. Anything that turns on server-side tools, provider-side egress
 * (MCP connector), premium speed or model fallback is rejected; other unknown betas are dropped.
 */
export const ALLOWED_BETAS = new Set([
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'fine-grained-tool-streaming-2025-05-14',
  'token-efficient-tools-2025-02-19',
  'claude-code-20250219',
  'compact-2026-01-12',
]);
const FORBIDDEN_BETA =
  /^(mcp-client|fast-mode|code-execution|files-api|skills|web-search|web-fetch|computer-use|oauth|server-side-fallback|message-threads|managed-agents)/;

/** Filter an anthropic-beta header value. Throws for betas that must never pass. */
export function filterBetas(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const kept: string[] = [];
  for (const raw of header.split(',')) {
    const b = raw.trim();
    if (!b) continue;
    if (FORBIDDEN_BETA.test(b))
      throw new ValidationError(`Beta "${b}" is not allowed through the proxy`);
    if (ALLOWED_BETAS.has(b)) kept.push(b);
  }
  return kept.length ? kept.join(',') : undefined;
}

const passHeaders = (h?: Record<string, string>) => {
  const beta = filterBetas(h?.['anthropic-beta']);
  return beta ? { 'anthropic-beta': beta } : undefined;
};

/** Rough output-token estimate from streamed content (for calls that end before message_delta). */
function streamedChars(e: Anthropic.RawMessageStreamEvent): number {
  if (e.type !== 'content_block_delta') return 0;
  const d = e.delta as { type: string; text?: string; thinking?: string; partial_json?: string };
  return (d.text ?? d.thinking ?? d.partial_json ?? '').length;
}

/** Run `call` against a prepared client and always write one llm_calls row. */
async function metered(
  db: Db,
  ctx: LlmCallContext,
  prepared: PreparedCall,
  params: MessageStreamParams,
  opts: StreamModelOptions,
  deps: LlmProxyDeps,
): Promise<Anthropic.Message> {
  const now = deps.now ?? Date.now;
  const started = now();
  let usage = emptyUsage();
  let requestId: string | null = null;
  let chars = 0;
  try {
    const stream = prepared.messages.stream(
      { ...params, model: providerModelId(prepared.provider, prepared.model) },
      { signal: opts.signal, headers: passHeaders(opts.headers) },
    );
    for await (const e of stream) {
      usage = usageFromEvent(usage, e);
      chars += streamedChars(e);
      if (e.type === 'message_start') requestId = e.message.id ?? null;
      await opts.onEvent?.(e);
    }
    const final = await stream.finalMessage();
    usage = {
      ...mergeUsage(usage, final.usage),
      stopReason: final.stop_reason ?? usage.stopReason,
    };
    await recordCall(db, ctx, prepared, usage, {
      latencyMs: now() - started,
      ok: true,
      requestId,
    });
    return { ...final, model: prepared.model };
  } catch (err) {
    const pe = toProviderError(err);
    // The stream ended before its final usage (cancel, disconnect, error): keep the last usage
    // seen and estimate output from what was streamed (~4 chars/token). Marked 'incomplete'.
    const estimated = Math.ceil(chars / 4);
    const partial = {
      ...usage,
      outputTokens: Math.max(usage.outputTokens, estimated),
      stopReason: usage.stopReason ?? (requestId ? 'incomplete' : null),
    };
    await recordCall(db, ctx, prepared, partial, {
      latencyMs: now() - started,
      ok: false,
      errorType: pe.errorType,
      requestId,
    });
    throw pe;
  }
}

/**
 * One streamed, metered model call on the workspace's credential. Used in-process by the
 * interactive agent; the HTTP proxy below wraps the same steps.
 */
export async function streamModel(
  db: Db,
  ctx: LlmCallContext,
  params: MessageStreamParams,
  opts: StreamModelOptions = {},
  deps: LlmProxyDeps = {},
): Promise<Anthropic.Message> {
  const prepared = await prepareCall(db, ctx, params.model, deps);
  return metered(db, ctx, prepared, params, opts, deps);
}

// ---------------------------------------------------------------------------------------------
// HTTP proxy for sandboxes: POST /api/llm/v1/messages (Anthropic Messages API shape)
// ---------------------------------------------------------------------------------------------

/** Which usage bucket a job's calls count toward. */
export const TASK_FOR_JOB: Record<JobKind, LlmTask> = {
  generate: 'generation',
  redesign: 'generation',
  alternatives: 'generation',
  web_capture: 'import',
  ds_import_url: 'import',
  ds_import_figma: 'import',
  codegen: 'codegen',
  figma_export: 'codegen',
};

export const MAX_PROXY_BODY_BYTES = 16 * 1024 * 1024;
export const MAX_OUTPUT_TOKENS = 128_000;

/**
 * Custom (client-executed) tools only. Server tools (web search/fetch, code execution, MCP
 * toolsets, Anthropic-defined tools) all carry a `type` and would run unmetered work, or
 * provider-side egress past the sandbox's network allowlist, so they're rejected.
 */
const customTool = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().max(20_000).optional(),
    input_schema: z.record(z.string(), z.unknown()),
    type: z.literal('custom').optional(),
    cache_control: z.unknown().optional(),
    strict: z.boolean().optional(),
    eager_input_streaming: z.boolean().optional(),
  })
  .strict();

/** The Messages API fields the Agent SDK needs; anything else (mcp_servers, container, speed, service_tier, ...) is rejected. */
const proxyBody = z
  .object({
    model: z.string().min(1).max(100),
    max_tokens: z.number().int().min(0).max(MAX_OUTPUT_TOKENS),
    messages: z.array(z.unknown()).max(10_000),
    system: z.union([z.string(), z.array(z.unknown())]).optional(),
    tools: z.array(customTool).max(200).optional(),
    tool_choice: z.unknown().optional(),
    thinking: z.unknown().optional(),
    output_config: z
      .object({ effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional() })
      .strict()
      .optional(),
    metadata: z
      .object({ user_id: z.string().max(256).optional() })
      .strict()
      .optional(),
    stop_sequences: z.array(z.string().max(200)).max(8).optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    top_k: z.number().optional(),
    cache_control: z.unknown().optional(),
    context_management: z.unknown().optional(),
    stream: z.boolean().optional(),
  })
  .strict();

const countBody = z
  .object({
    model: z.string().min(1).max(100),
    messages: z.array(z.unknown()).max(10_000),
    system: z.union([z.string(), z.array(z.unknown())]).optional(),
    tools: z.array(customTool).max(200).optional(),
    tool_choice: z.unknown().optional(),
    thinking: z.unknown().optional(),
  })
  .strict();

/** Errors in the Anthropic API's shape, so SDKs in the sandbox handle them normally. */
export function anthropicError(status: number, type: string, message: string): Response {
  return Response.json({ type: 'error', error: { type, message } }, { status });
}

function errorResponse(err: unknown): Response {
  if (err instanceof JobTokenError) return anthropicError(401, 'authentication_error', err.message);
  if (err instanceof ValidationError)
    return anthropicError(400, 'invalid_request_error', err.message);
  if (err instanceof BudgetExceededError)
    return anthropicError(429, 'rate_limit_error', err.message);
  if (err instanceof NotFoundError)
    return anthropicError(400, 'invalid_request_error', err.message);
  if (err instanceof ProviderError) return anthropicError(err.status, err.errorType, err.message);
  console.error('[llm-proxy] unexpected error', err instanceof Error ? err.name : typeof err);
  return anthropicError(500, 'api_error', 'Internal proxy error');
}

async function readJson(req: Request, schema: z.ZodType): Promise<Record<string, unknown>> {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_PROXY_BODY_BYTES) throw new ValidationError('Request body too large');
  const text = await req.text();
  if (text.length > MAX_PROXY_BODY_BYTES) throw new ValidationError('Request body too large');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ValidationError('Invalid JSON');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success)
    throw new ValidationError(
      `Invalid request: ${parsed.error.issues[0]?.path.join('.') ?? ''} ${parsed.error.issues[0]?.message ?? ''}`.trim(),
    );
  return parsed.data as Record<string, unknown>;
}

const ctxForJob = (job: JobRow): LlmCallContext => ({
  workspaceId: job.workspaceId,
  task: TASK_FOR_JOB[job.kind],
  userId: job.createdBy,
  projectId: job.projectId,
  jobId: job.id,
  conversationId: job.conversationId,
});

export async function handleMessagesProxy(
  db: Db,
  req: Request,
  deps: LlmProxyDeps = {},
): Promise<Response> {
  try {
    const job = await verifyJobToken(db, tokenFromHeaders(req.headers));
    const body = await readJson(req, proxyBody);
    const { stream: wantsStream, ...rest } = body;
    const params = rest as unknown as MessageStreamParams;
    const ctx = ctxForJob(job);
    const prepared = await prepareCall(db, ctx, params.model, deps);
    const betas = filterBetas(req.headers.get('anthropic-beta'));
    const headers = { 'anthropic-beta': betas ?? '' };
    // Model calls count as job activity, throttled, so a long turn doesn't look like a dead sandbox.
    let lastBeat = 0;
    const beat = () => {
      const t = Date.now();
      if (t - lastBeat < HEARTBEAT_THROTTLE_MS) return;
      lastBeat = t;
      void touchJobHeartbeat(db, job.id).catch(() => {});
    };
    beat();
    const opts = {
      signal: req.signal,
      headers: headers['anthropic-beta'] ? headers : undefined,
      onEvent: beat,
    };

    if (!wantsStream) {
      const message = await metered(db, ctx, prepared, params, opts, deps);
      return Response.json(message);
    }

    // Stream: forward raw events as SSE. Wait for the first event so provider errors that happen
    // before any output (auth, 4xx) come back as a normal HTTP error status.
    const queue: Anthropic.RawMessageStreamEvent[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let failure: unknown = null;
    const notify = () => {
      wake?.();
      wake = null;
    };
    const done = metered(
      db,
      ctx,
      prepared,
      params,
      {
        ...opts,
        onEvent: (e) => {
          beat();
          queue.push(e);
          notify();
        },
      },
      deps,
    ).then(
      () => {
        finished = true;
        notify();
      },
      (e) => {
        failure = e;
        finished = true;
        notify();
      },
    );
    const waitForData = () =>
      new Promise<void>((r) => {
        if (queue.length || finished) r();
        else wake = r;
      });
    await waitForData();
    if (!queue.length && failure) return errorResponse(failure);

    async function* frames() {
      while (true) {
        if (!queue.length && !finished) await waitForData();
        while (queue.length) {
          const e = queue.shift()!;
          yield encodeSse({ event: e.type, data: e });
        }
        if (finished && !queue.length) break;
      }
      await done;
      if (failure) {
        const pe = toProviderError(failure);
        yield encodeSse({
          event: 'error',
          data: { type: 'error', error: { type: pe.errorType, message: pe.message } },
        });
      }
    }
    return new Response(sseStream(frames(), req.signal), { headers: SSE_HEADERS });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/llm/v1/messages/count_tokens: free on every route, so it isn't metered. */
export async function handleCountTokensProxy(
  db: Db,
  req: Request,
  deps: LlmProxyDeps = {},
): Promise<Response> {
  try {
    const job = await verifyJobToken(db, tokenFromHeaders(req.headers));
    const body = await readJson(req, countBody);
    const ctx = ctxForJob(job);
    const prepared = await prepareCall(db, ctx, String(body.model), {
      ...deps,
      budget: noopBudgetHook,
    });
    try {
      const res = await prepared.messages.countTokens(
        {
          ...(body as unknown as Anthropic.MessageCountTokensParams),
          model: providerModelId(prepared.provider, prepared.model),
        },
        { signal: req.signal },
      );
      return Response.json(res);
    } catch (e) {
      throw toProviderError(e);
    }
  } catch (err) {
    return errorResponse(err);
  }
}
