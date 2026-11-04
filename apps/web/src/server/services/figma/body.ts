/** Read an HTTP body as UTF-8 text, streaming, and stop as soon as it exceeds a byte cap. */

export class BodyTooLargeError extends Error {
  override name = 'BodyTooLargeError';
  constructor() {
    super('Body too large');
  }
}

export async function readTextCapped(
  source: { body: ReadableStream<Uint8Array> | null; headers: Headers },
  maxBytes: number,
): Promise<string> {
  const declared = Number(source.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new BodyTooLargeError();
  if (!source.body) return '';
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder('utf-8').decode(all);
}
