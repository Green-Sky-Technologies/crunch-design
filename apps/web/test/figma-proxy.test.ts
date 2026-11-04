/**
 * Plugin routes go through the app's real proxy (clerkMiddleware) with `Authorization: Bearer
 * cdp_…`. Clerk must pass the request through (not 401, not a handshake redirect), and must not
 * treat the plugin token as a session. No network: the key below is a syntactically valid dev
 * key for a nonexistent instance, and the bearer value is not a JWT.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest, type NextFetchEvent } from 'next/server';

const PK = `pk_test_${Buffer.from('figma-proxy-test.clerk.accounts.dev$').toString('base64')}`;
type Proxy = (req: NextRequest, ev: NextFetchEvent) => Promise<Response | undefined>;
let proxy: Proxy;

beforeAll(async () => {
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', PK);
  vi.stubEnv('CLERK_PUBLISHABLE_KEY', PK);
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_figmaProxyTestNotARealKey000000000000');
  vi.stubEnv('CLERK_TELEMETRY_DISABLED', '1');
  vi.stubEnv('NEXT_PUBLIC_CLERK_TELEMETRY_DISABLED', '1');
  proxy = (await import('@/proxy')).default as unknown as Proxy;
});

const event = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as NextFetchEvent;
const TOKEN = `cdp_${'A'.repeat(43)}`;

function request(path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest(new URL(path, 'http://localhost:3000'), {
    method: init.method ?? 'GET',
    headers: init.headers,
  });
}

/**
 * clerkMiddleware passes a request through either with NextResponse.next() or with a rewrite to
 * the same URL (it rewrites to attach its auth headers to the request).
 */
function passedThrough(res: Response | undefined, path: string) {
  if (!res) return true;
  if (res.status !== 200) return false;
  const rewrite = res.headers.get('x-middleware-rewrite');
  return (
    res.headers.get('x-middleware-next') === '1' ||
    (rewrite !== null && new URL(rewrite).pathname === path)
  );
}

describe('plugin routes through proxy.ts', () => {
  it('passes bearer-token requests through without a Clerk session', async () => {
    const res = await proxy(
      request('/api/figma/plugin/projects', {
        headers: { authorization: `Bearer ${TOKEN}`, origin: 'null' },
      }),
      event,
    );
    expect(passedThrough(res, '/api/figma/plugin/projects')).toBe(true);
    expect(res?.headers.get('location')).toBeNull(); // no handshake/sign-in redirect
    // Clerk records the request as signed out: the plugin token was not taken as a session...
    expect(res?.headers.get('x-clerk-auth-status')).toBe('signed-out');
    // ...and the Authorization header reaches the route handler unchanged.
    const forwarded = res?.headers.get('x-middleware-request-authorization');
    if (forwarded !== null && forwarded !== undefined) expect(forwarded).toBe(`Bearer ${TOKEN}`);
  });

  it('passes CORS preflights through to the route handler', async () => {
    const res = await proxy(
      request('/api/figma/plugin/projects', {
        method: 'OPTIONS',
        headers: {
          origin: 'null',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization',
        },
      }),
      event,
    );
    expect(passedThrough(res, '/api/figma/plugin/projects')).toBe(true);
    expect(res?.headers.get('location')).toBeNull();
  });
});
