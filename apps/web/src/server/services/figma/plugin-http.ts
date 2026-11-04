/**
 * HTTP plumbing for the Figma plugin API (`/api/figma/plugin/**`, Story 8.1).
 *
 * - Auth is `Authorization: Bearer <plugin token>` only. Clerk cookies are never consulted, so
 *   these routes work with no Clerk session (clerkMiddleware in proxy.ts doesn't block them).
 * - CORS: Figma plugin UIs run in an iframe with an opaque (`null`) origin. We allow exactly that
 *   origin (and requests with no Origin, e.g. the plugin main thread or curl), never `*`, and
 *   never with credentials. Other web origins get no CORS headers, so browsers can't read
 *   responses; since auth is bearer-only, a page could only use a token it already holds.
 * - Rate limits: per token for authenticated calls, per client IP for failed auth.
 * - Bodies are size-capped before parsing and validated with zod by each route.
 *
 * Deliberately free of `server-only`/Clerk imports so it's testable with plain Requests.
 */
import { ForbiddenError } from '@crunch/authz';
import { getDb, type Db } from '@crunch/db';
import { z } from 'zod';
import { ConflictError, LockedError } from '../design-docs';
import {
  authenticatePluginToken,
  bearerFrom,
  InvalidTokenError,
  MembershipUnavailableError,
  type MembershipVerifier,
  type PluginActor,
} from '../plugin-tokens';
import { NotFoundError, ValidationError } from '../types';
import { BodyTooLargeError, readTextCapped } from './body';
import { RateLimitedError, RateLimiter } from './rate-limit';

/** Requests per minute per token. */
export const PLUGIN_RATE_LIMIT = 120;
/** Failed authentications per minute per client. */
export const AUTH_FAIL_LIMIT = 20;
const tokenLimiter = new RateLimiter(PLUGIN_RATE_LIMIT, 60_000);
const authFailLimiter = new RateLimiter(AUTH_FAIL_LIMIT, 60_000);

const ALLOWED_ORIGIN = 'null';

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin');
  const base: Record<string, string> = { Vary: 'Origin' };
  if (origin !== ALLOWED_ORIGIN) return base;
  return {
    ...base,
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
  };
}

/** OPTIONS handler: only the plugin's null origin gets a successful preflight. */
export function pluginPreflight(req: Request): Response {
  const origin = req.headers.get('origin');
  if (origin !== null && origin !== ALLOWED_ORIGIN) {
    return new Response(null, { status: 403, headers: { Vary: 'Origin' } });
  }
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

function json(req: Request, body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(req),
      ...extra,
    },
  });
}

export function pluginError(req: Request, err: unknown): Response {
  if (err instanceof InvalidTokenError)
    return json(req, { error: 'unauthorized', message: err.message }, 401, {
      'WWW-Authenticate': 'Bearer',
    });
  if (err instanceof MembershipUnavailableError)
    return json(req, { error: 'unavailable', message: err.message }, 503, { 'Retry-After': '60' });
  if (err instanceof RateLimitedError)
    return json(req, { error: 'rate_limited', message: err.message }, 429, {
      'Retry-After': String(err.retryAfter),
    });
  if (err instanceof ForbiddenError)
    return json(req, { error: 'forbidden', message: "You don't have permission to do that." }, 403);
  if (err instanceof NotFoundError)
    return json(req, { error: 'not_found', message: err.message }, 404);
  if (err instanceof ConflictError)
    return json(req, { error: 'conflict', message: err.message, version: err.currentVersion }, 409);
  if (err instanceof LockedError) return json(req, { error: 'locked', message: err.message }, 423);
  if (err instanceof ValidationError)
    return json(
      req,
      { error: 'invalid', message: err.message, fieldErrors: err.fieldErrors },
      err.message === 'Request body too large' ? 413 : 400,
    );
  console.error(
    '[figma-plugin] unexpected error',
    err instanceof Error ? `${err.name}: ${err.message}` : typeof err,
  );
  return json(req, { error: 'internal', message: 'Something went wrong' }, 500);
}

const IP_RE = /^[0-9a-fA-F:.]{2,45}$/;

/**
 * Client address for rate limiting. Prefer headers the platform sets (Vercel overwrites
 * x-vercel-forwarded-for / x-real-ip); otherwise use the right-most X-Forwarded-For hop, which
 * our nearest proxy appended (the left-most entries are client-controlled). Non-IP values are
 * ignored so clients can't mint arbitrary limiter keys.
 */
export function clientKey(req: Request): string {
  const candidates = [
    req.headers.get('x-vercel-forwarded-for')?.split(',')[0],
    req.headers.get('x-real-ip'),
    req.headers.get('x-forwarded-for')?.split(',').pop(),
  ];
  for (const c of candidates) {
    const v = c?.trim();
    if (v && IP_RE.test(v)) return v;
  }
  return 'unknown';
}

/** Read and validate a JSON body with a byte cap. */
export async function pluginBody<T>(
  req: Request,
  schema: z.ZodType<T>,
  maxBytes: number,
): Promise<T> {
  let text: string;
  try {
    text = await readTextCapped(req, maxBytes);
  } catch (e) {
    if (e instanceof BodyTooLargeError) throw new ValidationError('Request body too large');
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ValidationError('Invalid JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new ValidationError(
      `Invalid request: ${first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'invalid'}`,
    );
  }
  return r.data;
}

export interface PluginContext<P> {
  req: Request;
  actor: PluginActor;
  db: Db;
  params: P;
}

export interface PluginRouteOptions {
  /** Injected in tests; defaults to the shared pool. */
  db?: () => Db;
  /** Injected in tests; defaults to Clerk's backend API. */
  verify?: MembershipVerifier;
}

/** Wrap a plugin route handler with CORS, bearer auth, rate limiting and error mapping. */
export function pluginRoute<P = Record<string, never>>(
  handler: (c: PluginContext<P>) => Promise<unknown>,
  opts: PluginRouteOptions = {},
) {
  return async (req: Request, ctx?: { params: Promise<P> }): Promise<Response> => {
    try {
      const origin = req.headers.get('origin');
      if (origin !== null && origin !== ALLOWED_ORIGIN) {
        throw new ForbiddenError('workspace:read');
      }
      const db = (opts.db ?? (() => getDb()))();
      let actor: PluginActor;
      try {
        actor = await authenticatePluginToken(db, bearerFrom(req.headers.get('authorization')), {
          verify: opts.verify,
        });
      } catch (e) {
        if (e instanceof InvalidTokenError) authFailLimiter.check(clientKey(req));
        throw e;
      }
      tokenLimiter.check(actor.tokenId);
      const params = ctx ? await ctx.params : ({} as P);
      const out = await handler({ req, actor, db, params });
      return json(req, out);
    } catch (e) {
      return pluginError(req, e);
    }
  };
}
