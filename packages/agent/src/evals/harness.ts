/**
 * Agent eval harness (Story 5.13): golden prompts → assertions on patch scope, lint cleanliness,
 * job hand-off and token usage. Runs the real interactive loop (prefix, turn context, tools)
 * against an in-memory doc, with any ModelGateway: a live client for on-demand runs, or a
 * scripted one in unit tests.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { LintDoc } from '@crunch/contracts';
import {
  sampleLandingDoc,
  starterDesignSystem,
  type DesignDoc,
  type DesignSystemSpec,
} from '@crunch/doc-model';
import { lintDoc } from '@crunch/ds-lint';
import { z } from 'zod';
import { subtreeIds } from '../context';
import { runAgentTurn, type ModelGateway } from '../interactive';
import { memoryHost } from '../memory-host';
import { buildPrefix } from '../prefix';
import { buildTurnContext } from '../turn-context';
import { emptyUsage, estimateCostMicros, mergeUsage, type UsageTotals } from '../usage';

export const FIXTURES: Record<string, () => { doc: DesignDoc; ds: DesignSystemSpec }> = {
  landing: () => ({ doc: sampleLandingDoc(), ds: starterDesignSystem() }),
};

export const goldenCase = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    description: z.string(),
    fixture: z.enum(Object.keys(FIXTURES) as [string, ...string[]]),
    prompt: z.string().min(1),
    selection: z.array(z.string()).optional(),
    /** Ask-agent style request scoped to this node (Story 5.7). */
    scopeNodeId: z.string().optional(),
    expect: z
      .object({
        /** Every touched node must be one of these, or inside one of these subtrees. */
        touchWithin: z.array(z.string()).optional(),
        /** Each of these must be touched. */
        mustTouch: z.array(z.string()).optional(),
        maxTouched: z.number().int().positive().optional(),
        /** No transactions at all (e.g. a request that should become a job). */
        noEdits: z.boolean().optional(),
        /** Expected job hand-off kind, or null for "must not suggest a job". */
        jobSuggestion: z.enum(['generate', 'redesign', 'alternatives']).nullable().optional(),
        /** No lint errors on touched nodes. */
        lintClean: z.boolean().optional(),
        /** Token budget for the whole turn (all iterations). */
        maxInputTokens: z.number().int().positive().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
        maxIterations: z.number().int().positive().optional(),
      })
      .strict(),
  })
  .strict();
export type GoldenCase = z.infer<typeof goldenCase>;

export interface CaseResult {
  id: string;
  model: string;
  passed: boolean;
  failures: string[];
  touched: string[];
  transactions: number;
  iterations: number;
  jobSuggestion: string | null;
  usage: Omit<UsageTotals, 'stopReason'> & { estCostMicros: number };
}

export interface RunCaseOptions {
  gateway: ModelGateway;
  model: string;
  lint?: LintDoc;
}

/** Wrap a gateway to sum usage across the turn's iterations. */
function metering(gateway: ModelGateway) {
  let usage = emptyUsage();
  const wrapped: ModelGateway = async (params, opts) => {
    const m: Anthropic.Message = await gateway(params, opts);
    const u = mergeUsage(emptyUsage(), m.usage);
    usage = {
      ...usage,
      inputTokens: usage.inputTokens + u.inputTokens,
      outputTokens: usage.outputTokens + u.outputTokens,
      cacheReadTokens: usage.cacheReadTokens + u.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens + u.cacheWriteTokens,
      cacheWrite1hTokens: usage.cacheWrite1hTokens + u.cacheWrite1hTokens,
    };
    return m;
  };
  return { wrapped, usage: () => usage };
}

export async function runCase(c: GoldenCase, o: RunCaseOptions): Promise<CaseResult> {
  const { doc, ds } = FIXTURES[c.fixture]!();
  const scoped = c.scopeNodeId ? { rootNodeId: c.scopeNodeId, allowWider: false } : undefined;
  const host = memoryHost(doc, ds, { scope: scoped, maxOpsPerPatch: 200 });
  const userTurn: Anthropic.MessageParam = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: buildTurnContext(
          doc,
          c.scopeNodeId ? { scopeNodeId: c.scopeNodeId } : { selection: c.selection },
        ),
      },
      { type: 'text', text: c.prompt },
    ],
  };
  const meter = metering(o.gateway);
  const failures: string[] = [];
  let result: Awaited<ReturnType<typeof runAgentTurn>> | null = null;
  try {
    result = await runAgentTurn({
      gateway: meter.wrapped,
      model: o.model,
      prefix: buildPrefix('interactive', ds, '5m'),
      history: [],
      userTurn,
      host,
      maxIterations: c.expect.maxIterations ?? 10,
    });
  } catch (e) {
    failures.push(`turn failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const touched = result?.touched ?? [];
  const e = c.expect;

  if (e.noEdits && host.commits.length)
    failures.push(`expected no edits, got ${host.commits.length} transaction(s)`);
  if (e.touchWithin) {
    const allowed = new Set(e.touchWithin.flatMap((id) => [...subtreeIds(doc, id)]));
    // Nodes the agent created count as inside if their parent was allowed (checked via the final doc).
    const created = (id: string) =>
      !doc.nodes[id] && host.doc.nodes[id]?.parentId && allowed.has(host.doc.nodes[id]!.parentId!);
    const outside = touched.filter((id) => !allowed.has(id) && !created(id));
    if (outside.length)
      failures.push(
        `patch scope: touched outside ${e.touchWithin.join(', ')}: ${outside.join(', ')}`,
      );
  }
  for (const id of e.mustTouch ?? [])
    if (!touched.includes(id)) failures.push(`expected ${id} to be edited`);
  if (e.maxTouched !== undefined && touched.length > e.maxTouched)
    failures.push(`touched ${touched.length} nodes (max ${e.maxTouched})`);
  if (e.jobSuggestion !== undefined) {
    const got = result?.jobSuggestion?.kind ?? null;
    if (got !== e.jobSuggestion)
      failures.push(`job suggestion: expected ${e.jobSuggestion}, got ${got}`);
  }
  if (e.lintClean && touched.length) {
    const ids = touched.filter((id) => host.doc.nodes[id]);
    const errors = (o.lint ?? lintDoc)(host.doc, ds, { nodeIds: ids }).filter(
      (i) => i.severity === 'error',
    );
    if (errors.length)
      failures.push(`lint: ${errors.map((i) => `${i.code}@${i.nodeId ?? '?'}`).join(', ')}`);
  }
  const usage = meter.usage();
  if (e.maxInputTokens !== undefined) {
    const input = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    if (input > e.maxInputTokens)
      failures.push(`input tokens ${input} > budget ${e.maxInputTokens}`);
  }
  if (e.maxOutputTokens !== undefined && usage.outputTokens > e.maxOutputTokens)
    failures.push(`output tokens ${usage.outputTokens} > budget ${e.maxOutputTokens}`);

  const { stopReason: _s, ...u } = usage;
  return {
    id: c.id,
    model: o.model,
    passed: failures.length === 0,
    failures,
    touched,
    transactions: host.commits.length,
    iterations: result?.iterations ?? 0,
    jobSuggestion: result?.jobSuggestion?.kind ?? null,
    usage: { ...u, estCostMicros: estimateCostMicros(o.model, usage) },
  };
}

export interface EvalReport {
  model: string;
  ranAt: string;
  passed: number;
  failed: number;
  results: CaseResult[];
}

export interface Regression {
  id: string;
  kind: 'now-failing' | 'tokens-up';
  detail: string;
}

/**
 * Regressions against a stored baseline for the same model: cases that passed and now fail, and
 * cases whose output tokens grew by more than `tokenSlack` (default 25%).
 */
export function compareToBaseline(
  current: EvalReport,
  baseline: EvalReport | null,
  tokenSlack = 0.25,
): Regression[] {
  if (!baseline) return [];
  const before = new Map(baseline.results.map((r) => [r.id, r]));
  const out: Regression[] = [];
  for (const r of current.results) {
    const b = before.get(r.id);
    if (!b) continue;
    if (b.passed && !r.passed)
      out.push({ id: r.id, kind: 'now-failing', detail: r.failures.join('; ') });
    if (b.usage.outputTokens > 0 && r.usage.outputTokens > b.usage.outputTokens * (1 + tokenSlack))
      out.push({
        id: r.id,
        kind: 'tokens-up',
        detail: `output tokens ${b.usage.outputTokens} → ${r.usage.outputTokens}`,
      });
  }
  return out;
}

export function summarize(
  model: string,
  results: CaseResult[],
  ranAt = new Date().toISOString(),
): EvalReport {
  const passed = results.filter((r) => r.passed).length;
  return { model, ranAt, passed, failed: results.length - passed, results };
}
