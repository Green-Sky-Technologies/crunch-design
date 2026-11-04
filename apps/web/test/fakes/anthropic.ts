/**
 * Fake Anthropic message streams for tests. No network, no keys, no spend.
 * `scriptedClient` replays one scripted response per call, in order.
 */
import type { Anthropic } from '@crunch/agent';
import type { MessagesApi, ModelStream } from '@/server/services/llm-proxy';

export interface ScriptedResponse {
  content: Anthropic.ContentBlock[];
  stopReason?: Anthropic.StopReason;
  usage?: Partial<Anthropic.Usage>;
  /** Throw this instead of responding. */
  error?: unknown;
}

const baseUsage = (u: Partial<Anthropic.Usage> = {}): Anthropic.Usage =>
  ({
    input_tokens: 100,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: null,
    server_tool_use: null,
    service_tier: null,
    inference_geo: null,
    output_tokens_details: null,
    ...u,
  }) as Anthropic.Usage;

export function textBlock(text: string): Anthropic.TextBlock {
  return { type: 'text', text, citations: null } as Anthropic.TextBlock;
}

export function toolUse(id: string, name: string, input: unknown): Anthropic.ToolUseBlock {
  return {
    type: 'tool_use',
    id,
    name,
    input,
    caller: { type: 'direct' },
  } as Anthropic.ToolUseBlock;
}

/** Build the raw event sequence the real API streams for a message. */
export function eventsFor(model: string, r: ScriptedResponse): Anthropic.RawMessageStreamEvent[] {
  const usage = baseUsage(r.usage);
  const message = {
    id: `msg_fake_${Math.random().toString(36).slice(2, 10)}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    stop_details: null,
    usage: { ...usage, output_tokens: 1 },
  } as unknown as Anthropic.Message;
  const events: Anthropic.RawMessageStreamEvent[] = [{ type: 'message_start', message }];
  r.content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { ...block, text: '' },
      } as Anthropic.RawMessageStreamEvent);
      for (const chunk of block.text.match(/[\s\S]{1,8}/g) ?? [])
        events.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: chunk },
        } as Anthropic.RawMessageStreamEvent);
    } else if (block.type === 'tool_use') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { ...block, input: {} },
      } as Anthropic.RawMessageStreamEvent);
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      } as Anthropic.RawMessageStreamEvent);
    }
    events.push({ type: 'content_block_stop', index } as Anthropic.RawMessageStreamEvent);
  });
  events.push({
    type: 'message_delta',
    delta: { stop_reason: r.stopReason ?? 'end_turn', stop_sequence: null },
    usage: {
      output_tokens: usage.output_tokens,
      input_tokens: usage.input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
    },
  } as Anthropic.RawMessageStreamEvent);
  events.push({ type: 'message_stop' } as Anthropic.RawMessageStreamEvent);
  return events;
}

export function fakeStream(model: string, r: ScriptedResponse, signal?: AbortSignal): ModelStream {
  const events = r.error ? [] : eventsFor(model, r);
  const final = {
    id: 'msg_fake_final',
    type: 'message',
    role: 'assistant',
    model,
    content: r.content,
    stop_reason: r.stopReason ?? 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: baseUsage(r.usage),
  } as unknown as Anthropic.Message;
  return {
    async *[Symbol.asyncIterator]() {
      if (r.error) throw r.error;
      for (const e of events) {
        if (signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
        yield e;
      }
    },
    finalMessage: async () => {
      if (r.error) throw r.error;
      return final;
    },
  };
}

export interface ScriptedClient {
  messages: MessagesApi;
  /** Request bodies received, in order. */
  calls: Anthropic.MessageStreamParams[];
  headers: (Record<string, string> | undefined)[];
}

export function scriptedClient(script: ScriptedResponse[]): ScriptedClient {
  const calls: Anthropic.MessageStreamParams[] = [];
  const headers: (Record<string, string> | undefined)[] = [];
  let i = 0;
  return {
    calls,
    headers,
    messages: {
      stream(body, opts) {
        calls.push(structuredClone(body));
        headers.push(opts?.headers);
        const r = script[Math.min(i++, script.length - 1)];
        if (!r) throw new Error('scriptedClient: no responses');
        return fakeStream(body.model, r, opts?.signal);
      },
      async countTokens() {
        return { input_tokens: 42 } as Anthropic.MessageTokensCount;
      },
    },
  };
}
