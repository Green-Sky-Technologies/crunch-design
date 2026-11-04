/** Server-Sent Events encoding (SPEC D6: SSE, not WebSockets). */

export interface SseMessage {
  event?: string;
  /** Becomes `id:`; clients resume with Last-Event-ID. */
  id?: string | number;
  data: unknown;
  /** Reconnect delay hint (ms). */
  retry?: number;
}

export function encodeSse(m: SseMessage): string {
  let out = '';
  if (m.retry !== undefined) out += `retry: ${m.retry}\n`;
  if (m.id !== undefined) out += `id: ${m.id}\n`;
  if (m.event) out += `event: ${m.event}\n`;
  const data = typeof m.data === 'string' ? m.data : JSON.stringify(m.data);
  for (const line of data.split('\n')) out += `data: ${line}\n`;
  return out + '\n';
}

/** A comment line keeps proxies from closing an idle stream. */
export const SSE_KEEPALIVE = ': keepalive\n\n';

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

/** Turn an async iterable of SSE frames into a byte stream; aborting the request stops iteration. */
export function sseStream(
  frames: AsyncIterable<string>,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const it = frames[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal?.aborted) {
        await it.return?.();
        controller.close();
        return;
      }
      try {
        const { value, done } = await it.next();
        if (done) controller.close();
        else controller.enqueue(enc.encode(value));
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel() {
      await it.return?.();
    },
  });
}

/** Parse an SSE byte stream into messages (used by tests and the browser client). */
export function parseSse(text: string): { event?: string; id?: string; data: string }[] {
  const out: { event?: string; id?: string; data: string }[] = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    let event: string | undefined;
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'id') id = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length || event) out.push({ event, id, data: data.join('\n') });
  }
  return out;
}
