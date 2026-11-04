import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError } from '@crunch/authz';
import { llmCalls } from '@crunch/db';
import { formatUsd, usageSummary } from '@/server/services/usage';
import { upsertUser } from '@/server/services/workspaces';
import { makeActor, reset, testDb } from './helpers';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

describe('usage dashboard', () => {
  it('aggregates per workspace, member, model, task and day with cache hit rate', async () => {
    const admin = await makeActor(db, 'admin');
    const editor = await makeActor(db, 'editor', admin.workspace);
    const other = await makeActor(db, 'admin');
    await upsertUser(db, { id: editor.userId, email: 'ed@example.com', name: 'Ed' });
    const row = (over: Partial<typeof llmCalls.$inferInsert>) => ({
      workspaceId: admin.workspace.id,
      userId: editor.userId,
      task: 'interactive' as const,
      provider: 'anthropic' as const,
      model: 'claude-sonnet-5-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
      estCostMicros: 1000,
      latencyMs: 400,
      ...over,
    });
    await db.insert(llmCalls).values([
      row({}),
      row({ ok: false, errorType: 'rate_limit_error', estCostMicros: 0 }),
      row({
        userId: admin.userId,
        task: 'generation',
        model: 'claude-opus-5-5',
        estCostMicros: 5000,
      }),
      row({ workspaceId: other.workspace.id, estCostMicros: 999_999 }), // another workspace
      row({ createdAt: new Date(Date.now() - 40 * 86_400_000), estCostMicros: 777 }), // too old
    ]);

    const s = await usageSummary(db, admin, { days: 30 });
    expect(s.totals).toMatchObject({ calls: 3, errors: 1, costMicros: 6000, inputTokens: 300 });
    expect(s.totals.cacheHitRate).toBeCloseTo(0.8); // 2400 / (300 + 2400 + 300)
    expect(s.byModel.map((r) => r.key)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(s.byTask.find((r) => r.key === 'interactive')).toMatchObject({
      calls: 2,
      costMicros: 1000,
    });
    expect(s.byMember).toHaveLength(2);
    expect(s.byMember.find((r) => r.key === editor.userId)).toMatchObject({
      calls: 2,
      label: 'Ed',
    });
    expect(s.byDay).toHaveLength(1);
    expect(formatUsd(7000)).toBe('$0.0070');
    expect(formatUsd(1_234_567)).toBe('$1.23');
  });

  it('flags partner-priced and incomplete calls', async () => {
    const admin = await makeActor(db, 'admin');
    const call = (provider: 'anthropic' | 'bedrock' | 'vertex', stopReason: string | null) => ({
      workspaceId: admin.workspace.id,
      task: 'generation' as const,
      provider,
      model: 'claude-opus-5-5',
      stopReason,
    });
    await db
      .insert(llmCalls)
      .values([
        call('bedrock', 'end_turn'),
        call('vertex', 'incomplete'),
        call('anthropic', 'end_turn'),
      ]);
    const s = await usageSummary(db, admin);
    expect(s.totals).toMatchObject({ calls: 3, partnerPricedCalls: 2, incompleteCalls: 1 });
  });

  it('is admin-only', async () => {
    const editor = await makeActor(db, 'editor');
    await expect(usageSummary(db, editor)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
