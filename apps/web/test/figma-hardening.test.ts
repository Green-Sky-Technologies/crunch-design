/** Plugin API hardening: client IP keying, bounded limiter, streamed byte caps, asset URLs. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BodyTooLargeError, readTextCapped } from '@/server/services/figma/body';
import { clientKey, pluginBody } from '@/server/services/figma/plugin-http';
import { RateLimiter } from '@/server/services/figma/rate-limit';
import { FigmaRest, isAllowedAssetUrl, type FigmaFetch } from '@/server/services/figma/rest';

const withHeaders = (h: Record<string, string>) => new Request('http://x/', { headers: h });

describe('client keys for auth-failure limits', () => {
  it('prefers platform-set IPs and ignores the spoofable left-most X-Forwarded-For', () => {
    expect(
      clientKey(
        withHeaders({ 'x-forwarded-for': '6.6.6.6, 10.0.0.1', 'x-real-ip': '203.0.113.9' }),
      ),
    ).toBe('203.0.113.9');
    expect(
      clientKey(
        withHeaders({ 'x-vercel-forwarded-for': '198.51.100.7', 'x-real-ip': '203.0.113.9' }),
      ),
    ).toBe('198.51.100.7');
    // Without platform headers, only the right-most hop (added by our proxy) is trusted.
    expect(clientKey(withHeaders({ 'x-forwarded-for': '6.6.6.6, 192.0.2.4' }))).toBe('192.0.2.4');
    expect(clientKey(withHeaders({ 'x-forwarded-for': 'random-key-123' }))).toBe('unknown');
  });

  it('bounds the limiter map under a flood of distinct keys', () => {
    const rl = new RateLimiter(5, 60_000, () => 0, 100);
    for (let i = 0; i < 1000; i++) rl.hit(`k${i}`);
    expect(rl.size).toBeLessThanOrEqual(100);
  });
});

describe('streamed byte caps', () => {
  const endless = () => {
    const state = { pulled: 0 };
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        state.pulled++;
        c.enqueue(new Uint8Array(64 * 1024));
      },
    });
    return { stream, state };
  };

  it('stops reading as soon as the cap is exceeded', async () => {
    const { stream, state } = endless();
    await expect(
      readTextCapped({ body: stream, headers: new Headers() }, 256 * 1024),
    ).rejects.toThrow(BodyTooLargeError);
    expect(state.pulled).toBeLessThan(10);
  });

  it('counts bytes, not UTF-16 units', async () => {
    const emoji = '😀'.repeat(300); // 1200 bytes, 600 UTF-16 units
    const req = () => new Request('http://x', { method: 'POST', body: emoji });
    await expect(readTextCapped(req(), 1000)).rejects.toThrow(BodyTooLargeError);
    expect(await readTextCapped(req(), 1200)).toBe(emoji);
  });

  it('pluginBody rejects chunked bodies with no content-length', async () => {
    const { stream } = endless();
    const init = { method: 'POST', body: stream, duplex: 'half' } as RequestInit;
    await expect(pluginBody(new Request('http://x', init), z.unknown(), 1024)).rejects.toThrow(
      'Request body too large',
    );
  });
});

describe('Figma asset fetching', () => {
  it('allows only https Figma/S3 asset hosts', () => {
    expect(isAllowedAssetUrl('https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/a')).toBe(
      true,
    );
    expect(isAllowedAssetUrl('https://www.figma.com/x')).toBe(true);
    for (const bad of [
      'http://figma-alpha-api.s3.us-west-2.amazonaws.com/a',
      'https://figma.com.evil.example/a',
      'https://evil-figma.com/a',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/a',
      'file:///etc/passwd',
      'not a url',
    ])
      expect(isAllowedAssetUrl(bad), bad).toBe(false);
  });

  it('never follows redirects and skips disallowed render URLs', async () => {
    const seen: { url: string; redirect?: RequestRedirect }[] = [];
    const fetcher: FigmaFetch = async (url, init) => {
      seen.push({ url, redirect: init?.redirect });
      if (url.startsWith('https://api.figma.com/v1/images/'))
        return Response.json({
          images: {
            '1:1': 'https://figma-alpha-api.s3.us-west-2.amazonaws.com/a.svg',
            '1:2': 'https://internal.example/b.svg',
          },
        });
      return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>');
    };
    const svgs = await new FigmaRest('figd_token', fetcher).svgs('AbCdEfGhIjKl1234', [
      '1:1',
      '1:2',
    ]);
    expect(Object.keys(svgs)).toEqual(['1:1']);
    expect(seen.map((s) => s.url)).not.toContain('https://internal.example/b.svg');
    expect(seen.every((s) => s.redirect === 'error')).toBe(true);
  });

  it('caps SVG downloads by bytes', async () => {
    const fetcher: FigmaFetch = async (url) =>
      url.startsWith('https://api.figma.com')
        ? Response.json({ images: { '1:1': 'https://s3-alpha.figma.com/a.svg' } })
        : new Response(`<svg>${'x'.repeat(300 * 1024)}</svg>`);
    expect(await new FigmaRest('t', fetcher).svgs('AbCdEfGhIjKl1234', ['1:1'])).toEqual({});
  });
});
