import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { sampleLandingDoc, starterDesignSystem, type DesignSystemSpec } from '@crunch/doc-model';
import {
  buildPrefix,
  buildTurnContext,
  detectJobRequest,
  memoryHost,
  prefixBytes,
  runAgentTurn,
  turnText,
  type ModelGateway,
} from './index';

type Block = Anthropic.ContentBlock;
const text = (t: string) => ({ type: 'text', text: t, citations: null }) as Block;
const toolUse = (id: string, name: string, input: unknown) =>
  ({ type: 'tool_use', id, name, input }) as Block;

/** A gateway that replays scripted responses and records requests. */
export function scriptedGateway(script: { content: Block[]; stop?: Anthropic.StopReason }[]) {
  const requests: Parameters<ModelGateway>[0][] = [];
  let i = 0;
  const gateway: ModelGateway = async (params, opts) => {
    requests.push(structuredClone(params));
    const r = script[Math.min(i++, script.length - 1)]!;
    r.content.forEach((b, index) => {
      opts.onEvent?.({ type: 'content_block_start', index, content_block: b } as never);
    });
    return {
      id: `msg_${i}`,
      type: 'message',
      role: 'assistant',
      model: params.model,
      content: r.content,
      stop_reason:
        r.stop ?? (r.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'),
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    } as unknown as Anthropic.Message;
  };
  return { gateway, requests };
}

const ds = starterDesignSystem();
const userTurn = (t: string): Anthropic.MessageParam => ({
  role: 'user',
  content: [{ type: 'text', text: t }],
});

describe('cached prefix', () => {
  it('is byte-stable regardless of key insertion order, and has no timestamps', () => {
    const shuffled = JSON.parse(JSON.stringify(ds)) as DesignSystemSpec;
    const reversedTokens = Object.fromEntries(Object.entries(shuffled.tokens).reverse());
    const { guidelines, ...rest } = shuffled;
    const reordered = { guidelines, ...rest, tokens: reversedTokens };
    const a = prefixBytes(buildPrefix('interactive', ds));
    const b = prefixBytes(buildPrefix('interactive', reordered as DesignSystemSpec));
    expect(a).toBe(b);
    expect(a).not.toMatch(/20\d\d-\d\d-\d\dT/);
  });

  it('sorts tools by name, marks the design-system block for 1h caching', () => {
    const p = buildPrefix('interactive', ds);
    const names = p.tools.map((t) => t.name);
    expect(names).toEqual([...names].sort());
    expect(names).toContain('suggest_generation_job');
    expect(p.system.at(-1)!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(buildPrefix('interactive', ds, '5m').system.at(-1)!.cache_control).toEqual({
      type: 'ephemeral',
    });
    expect(buildPrefix('job', ds).tools.map((t) => t.name)).not.toContain('suggest_generation_job');
  });
});

describe('turn context', () => {
  it('sends an outline plus the selected subtree for chat', () => {
    const ctx = buildTurnContext(sampleLandingDoc(), { selection: ['n_herotitle1'] });
    expect(ctx).toContain('<outline>');
    expect(ctx).toContain('<subtree root="n_herotitle1">');
    // Other nodes appear only as outline lines (short text), never as full JSON.
    expect(ctx).not.toContain('Every frame is real DOM, so what you see is what ships.');
    expect(ctx).not.toContain('"id":"n_feat1card00"');
  });

  it('sends only the scoped subtree for ask-agent requests', () => {
    const ctx = buildTurnContext(sampleLandingDoc(), { scopeNodeId: 'n_hero000001' });
    expect(ctx).not.toContain('<outline>');
    expect(ctx).toContain('n_herotitle1');
    expect(ctx).not.toContain('n_features01');
    expect(ctx).toContain('Page › Hero');
  });
});

describe('job detection', () => {
  it.each([
    ['Design a pricing page', 'generate'],
    ['create a new landing page for a bakery', 'generate'],
    ['Show 3 alternative layouts', 'alternatives'],
    ['give me three variations', 'alternatives'],
    ['Redesign the hero', 'redesign'],
  ])('%s -> %s', (prompt, kind) => {
    expect(detectJobRequest(prompt)?.kind).toBe(kind);
  });

  it.each(['make this button larger', 'darker colour scheme', 'change the page title to Hi'])(
    'leaves %s to the interactive path',
    (prompt) => expect(detectJobRequest(prompt)).toBeNull(),
  );
});

describe('runAgentTurn', () => {
  it('a one-node change emits one patch touching only that node', async () => {
    const host = memoryHost(sampleLandingDoc(), ds);
    const { gateway, requests } = scriptedGateway([
      {
        content: [
          text('Making it larger.'),
          toolUse('tu_1', 'patch_nodes', {
            label: 'Larger CTA',
            ops: [
              {
                op: 'setStyle',
                id: 'n_herocta001',
                breakpoint: 'base',
                prop: 'paddingTop',
                value: { token: 'space.4' },
              },
            ],
          }),
        ],
      },
      { content: [text('Done: the button is larger.')] },
    ]);
    const updates: number[] = [];
    const res = await runAgentTurn({
      gateway,
      model: 'claude-sonnet-5-5',
      prefix: buildPrefix('interactive', ds),
      history: [],
      userTurn: userTurn('make this button larger'),
      host,
      onUpdate: (u) => updates.push(u.turns.length),
    });
    expect(res.touched).toEqual(['n_herocta001']);
    expect(res.txnIds).toHaveLength(1);
    expect(host.commits).toHaveLength(1);
    expect(res.turns.map((t) => t.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(turnText(res.turns)).toContain('Done');
    expect(updates.length).toBeGreaterThan(0);
    // The prefix is identical on every iteration (cache hits within the turn).
    expect(JSON.stringify(requests[0]!.system)).toBe(JSON.stringify(requests[1]!.system));
    expect(JSON.stringify(requests[0]!.tools)).toBe(JSON.stringify(requests[1]!.tools));
    expect(requests[0]!.cache_control).toEqual({ type: 'ephemeral' });
    const lastMsg = requests[1]!.messages.at(-1)!;
    expect((lastMsg.content as Anthropic.ToolResultBlockParam[])[0]!.type).toBe('tool_result');
  });

  it('records a job suggestion instead of editing', async () => {
    const host = memoryHost(sampleLandingDoc(), ds);
    const { gateway } = scriptedGateway([
      {
        content: [
          toolUse('tu_1', 'suggest_generation_job', {
            kind: 'generate',
            prompt: 'A pricing page',
            reason: 'Needs a new frame',
          }),
        ],
      },
      { content: [text('This needs a background job.')] },
    ]);
    const res = await runAgentTurn({
      gateway,
      model: 'claude-sonnet-5-5',
      prefix: buildPrefix('interactive', ds),
      history: [],
      userTurn: userTurn('a pricing page please'),
      host,
    });
    expect(res.jobSuggestion).toMatchObject({ kind: 'generate' });
    expect(host.commits).toHaveLength(0);
  });

  it('stops after maxIterations and on refusal', async () => {
    const host = memoryHost(sampleLandingDoc(), ds);
    const loop = scriptedGateway([{ content: [toolUse('tu_x', 'get_outline', {})] }]);
    const res = await runAgentTurn({
      gateway: loop.gateway,
      model: 'm',
      prefix: buildPrefix('interactive', ds),
      history: [],
      userTurn: userTurn('x'),
      host,
      maxIterations: 3,
    });
    expect(res).toMatchObject({ iterations: 3, stopReason: 'max_iterations' });
    const refusal = scriptedGateway([{ content: [], stop: 'refusal' }]);
    const r2 = await runAgentTurn({
      gateway: refusal.gateway,
      model: 'm',
      prefix: buildPrefix('interactive', ds),
      history: [],
      userTurn: userTurn('x'),
      host,
    });
    expect(r2.stopReason).toBe('refusal');
  });
});
