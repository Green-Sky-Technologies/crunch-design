/** A ModelGateway that replays scripted responses (tests and harness self-checks; no network). */
import type Anthropic from '@anthropic-ai/sdk';
import type { ModelGateway } from '../interactive';

export interface ScriptedTurn {
  content: Anthropic.ContentBlock[];
  stop?: Anthropic.StopReason;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
}

export const text = (t: string) =>
  ({ type: 'text', text: t, citations: null }) as Anthropic.ContentBlock;
export const toolUse = (id: string, name: string, input: unknown) =>
  ({ type: 'tool_use', id, name, input }) as Anthropic.ContentBlock;

export function scriptedGateway(script: ScriptedTurn[]) {
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
      usage: { input_tokens: 10, output_tokens: 5, ...r.usage },
    } as unknown as Anthropic.Message;
  };
  return { gateway, requests };
}
