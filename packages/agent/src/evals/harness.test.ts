import { describe, expect, it } from 'vitest';
import { FIXTURES, compareToBaseline, runCase, summarize, type GoldenCase } from './harness';
import { loadGoldenCases } from './cli';
import { scriptedGateway, text, toolUse } from './scripted';

const cases = loadGoldenCases();
const byId = (id: string) => cases.find((c) => c.id === id)!;

const setPadding = (id: string) =>
  toolUse('tu_1', 'patch_nodes', {
    label: 'Larger',
    ops: [
      { op: 'setStyle', id, breakpoint: 'base', prop: 'paddingTop', value: { token: 'space.4' } },
    ],
  });

describe('golden cases', () => {
  it('parse and reference nodes that exist in their fixture', () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) {
      const { doc } = FIXTURES[c.fixture]!();
      const ids = [
        ...(c.selection ?? []),
        ...(c.scopeNodeId ? [c.scopeNodeId] : []),
        ...(c.expect.touchWithin ?? []),
        ...(c.expect.mustTouch ?? []),
      ];
      for (const id of ids) expect(doc.nodes[id], `${c.id}: ${id}`).toBeDefined();
    }
  });
});

describe('eval harness (scripted model, no spend)', () => {
  it('passes a one-node change that stays in scope and budget', async () => {
    const { gateway } = scriptedGateway([
      { content: [setPadding('n_herocta001')], usage: { output_tokens: 120 } },
      { content: [text('Done.')], usage: { output_tokens: 20 } },
    ]);
    const r = await runCase(byId('button-larger-scoped'), { gateway, model: 'claude-sonnet-5-5' });
    expect(r).toMatchObject({
      passed: true,
      touched: ['n_herocta001'],
      transactions: 1,
      iterations: 2,
    });
    expect(r.usage.outputTokens).toBe(140);
    expect(r.usage.estCostMicros).toBeGreaterThan(0);
  });

  it('flags an out-of-scope patch (rejected by the host, so the target is untouched)', async () => {
    const { gateway } = scriptedGateway([
      { content: [setPadding('n_features01')] },
      { content: [text('Done.')] },
    ]);
    const r = await runCase(byId('button-larger-scoped'), { gateway, model: 'claude-sonnet-5-5' });
    expect(r.passed).toBe(false);
    expect(r.failures).toContain('expected n_herocta001 to be edited');
  });

  it('flags scope violations on unscoped chat edits and blown token budgets', async () => {
    const c: GoldenCase = { ...byId('headline-copy') };
    const { gateway } = scriptedGateway([
      {
        content: [
          toolUse('tu_1', 'patch_nodes', {
            label: 'x',
            ops: [
              {
                op: 'setProps',
                id: 'n_herotitle1',
                patch: { text: 'Design at the speed of thought' },
              },
              { op: 'setProps', id: 'n_herobody01', patch: { text: 'Also changed this' } },
            ],
          }),
        ],
        usage: { output_tokens: 5000 },
      },
      { content: [text('Done.')] },
    ]);
    const r = await runCase(c, { gateway, model: 'claude-sonnet-5-5' });
    expect(r.passed).toBe(false);
    expect(r.failures.join('\n')).toMatch(
      /patch scope: touched outside n_herotitle1: n_herobody01/,
    );
    expect(r.failures.join('\n')).toMatch(/output tokens 5005 > budget 2000/);
    expect(r.failures.join('\n')).toMatch(/touched 2 nodes \(max 1\)/);
  });

  it('checks the job hand-off and lint through the ds-lint contract', async () => {
    const { gateway } = scriptedGateway([
      {
        content: [
          toolUse('tu_1', 'suggest_generation_job', {
            kind: 'generate',
            prompt: 'Pricing page',
            reason: 'new page',
          }),
        ],
      },
      { content: [text('That needs a background job.')] },
    ]);
    expect((await runCase(byId('pricing-page-offers-job'), { gateway, model: 'm' })).passed).toBe(
      true,
    );

    const lintFails = await runCase(byId('button-larger-scoped'), {
      gateway: scriptedGateway([
        { content: [setPadding('n_herocta001')] },
        { content: [text('ok')] },
      ]).gateway,
      model: 'm',
      lint: () => [{ code: 'contrast', severity: 'error', message: 'low', nodeId: 'n_herocta001' }],
    });
    expect(lintFails.failures).toContain('lint: contrast@n_herocta001');
  });

  it('reports regressions per model against a baseline', () => {
    const base = summarize('m', [
      {
        id: 'a',
        model: 'm',
        passed: true,
        failures: [],
        touched: [],
        transactions: 1,
        iterations: 1,
        jobSuggestion: null,
        usage: {
          inputTokens: 1,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cacheWrite1hTokens: 0,
          estCostMicros: 1,
        },
      },
      {
        id: 'b',
        model: 'm',
        passed: true,
        failures: [],
        touched: [],
        transactions: 1,
        iterations: 1,
        jobSuggestion: null,
        usage: {
          inputTokens: 1,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cacheWrite1hTokens: 0,
          estCostMicros: 1,
        },
      },
    ]);
    const now = summarize('m', [
      { ...base.results[0]!, passed: false, failures: ['x'] },
      { ...base.results[1]!, usage: { ...base.results[1]!.usage, outputTokens: 200 } },
    ]);
    expect(compareToBaseline(now, base).map((r) => `${r.id}:${r.kind}`)).toEqual([
      'a:now-failing',
      'b:tokens-up',
    ]);
    expect(compareToBaseline(now, null)).toEqual([]);
  });
});
