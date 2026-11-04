/**
 * Usage dashboards (Story 5.10): tokens, cache reads/writes, estimated cost and cache hit rate
 * per workspace, member, model, task and day, aggregated from llm_calls. Admins only.
 */
import { assertCan } from '@crunch/authz';
import { and, eq, gte, llmCalls, sql, users, type Db } from '@crunch/db';
import type { Actor } from './types';

export interface UsageTotals {
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicros: number;
  /** cache read / (uncached input + cache read + cache write) */
  cacheHitRate: number;
  avgLatencyMs: number | null;
  /** Calls on Bedrock/Vertex: billed at partner rates, so their cost is a list-price estimate. */
  partnerPricedCalls: number;
  /** Calls that ended before final usage (cancel/disconnect); output tokens are estimated. */
  incompleteCalls: number;
}

export interface UsageRow extends UsageTotals {
  key: string;
  label: string;
}

export interface UsageSummary {
  days: number;
  since: string;
  totals: UsageTotals;
  byMember: UsageRow[];
  byModel: UsageRow[];
  byTask: UsageRow[];
  byDay: UsageRow[];
}

const aggregates = {
  calls: sql<number>`count(*)::int`,
  errors: sql<number>`count(*) filter (where not ${llmCalls.ok})::int`,
  inputTokens: sql<number>`coalesce(sum(${llmCalls.inputTokens}), 0)::bigint`,
  outputTokens: sql<number>`coalesce(sum(${llmCalls.outputTokens}), 0)::bigint`,
  cacheReadTokens: sql<number>`coalesce(sum(${llmCalls.cacheReadTokens}), 0)::bigint`,
  cacheWriteTokens: sql<number>`coalesce(sum(${llmCalls.cacheWriteTokens}), 0)::bigint`,
  costMicros: sql<number>`coalesce(sum(${llmCalls.estCostMicros}), 0)::bigint`,
  avgLatencyMs: sql<number | null>`avg(${llmCalls.latencyMs})::int`,
  partnerPricedCalls: sql<number>`count(*) filter (where ${llmCalls.provider} in ('bedrock', 'vertex'))::int`,
  incompleteCalls: sql<number>`count(*) filter (where ${llmCalls.stopReason} = 'incomplete')::int`,
};

type Agg = { [K in keyof typeof aggregates]: unknown };

function totals(r: Agg): UsageTotals {
  const n = (v: unknown) => Number(v ?? 0);
  const input = n(r.inputTokens);
  const read = n(r.cacheReadTokens);
  const write = n(r.cacheWriteTokens);
  const denom = input + read + write;
  return {
    calls: n(r.calls),
    errors: n(r.errors),
    inputTokens: input,
    outputTokens: n(r.outputTokens),
    cacheReadTokens: read,
    cacheWriteTokens: write,
    costMicros: n(r.costMicros),
    cacheHitRate: denom ? read / denom : 0,
    avgLatencyMs:
      r.avgLatencyMs === null || r.avgLatencyMs === undefined ? null : n(r.avgLatencyMs),
    partnerPricedCalls: n(r.partnerPricedCalls),
    incompleteCalls: n(r.incompleteCalls),
  };
}

export async function usageSummary(
  db: Db,
  actor: Actor,
  opts: { days?: number; now?: Date } = {},
): Promise<UsageSummary> {
  assertCan(actor.role, 'workspace:manage_credentials');
  const days = Math.min(Math.max(opts.days ?? 30, 1), 365);
  const since = new Date((opts.now ?? new Date()).getTime() - days * 86_400_000);
  const where = and(eq(llmCalls.workspaceId, actor.workspace.id), gte(llmCalls.createdAt, since));

  const [all] = await db.select(aggregates).from(llmCalls).where(where);
  const day = sql<string>`to_char(date_trunc('day', ${llmCalls.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
  const [byMember, byModel, byTask, byDay] = await Promise.all([
    db
      .select({ key: llmCalls.userId, name: users.name, email: users.email, ...aggregates })
      .from(llmCalls)
      .leftJoin(users, eq(users.id, llmCalls.userId))
      .where(where)
      .groupBy(llmCalls.userId, users.name, users.email)
      .orderBy(sql`sum(${llmCalls.estCostMicros}) desc`),
    db
      .select({ key: llmCalls.model, ...aggregates })
      .from(llmCalls)
      .where(where)
      .groupBy(llmCalls.model)
      .orderBy(sql`sum(${llmCalls.estCostMicros}) desc`),
    db
      .select({ key: llmCalls.task, ...aggregates })
      .from(llmCalls)
      .where(where)
      .groupBy(llmCalls.task)
      .orderBy(sql`sum(${llmCalls.estCostMicros}) desc`),
    db
      .select({ key: day, ...aggregates })
      .from(llmCalls)
      .where(where)
      .groupBy(day)
      .orderBy(day),
  ]);

  return {
    days,
    since: since.toISOString(),
    totals: totals(all!),
    byMember: byMember.map((r) => ({
      key: r.key ?? 'system',
      label: r.name ?? r.email ?? r.key ?? 'System',
      ...totals(r),
    })),
    byModel: byModel.map((r) => ({ key: r.key, label: r.key, ...totals(r) })),
    byTask: byTask.map((r) => ({ key: r.key, label: r.key, ...totals(r) })),
    byDay: byDay.map((r) => ({ key: r.key, label: r.key, ...totals(r) })),
  };
}

export const formatUsd = (micros: number) =>
  micros < 10_000 && micros > 0 ? `$${(micros / 1e6).toFixed(4)}` : `$${(micros / 1e6).toFixed(2)}`;
