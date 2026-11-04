/**
 * GET /s/:token — share viewer (Story 6.3).
 * Public links render without auth; workspace links require a signed-in member of the link's
 * workspace. Every failure returns the same 404 page. Rate-limited per client IP (per token
 * when no IP is available; see the deployment note in services/share-links.ts); noindex.
 */
import { getDb } from '@crunch/db';
import type { NextRequest } from 'next/server';
import { getActor } from '@/server/context';
import { resolveShareToken, shareRateKey, shareViewLimiter } from '@/server/services/share-links';
import type { Actor } from '@/server/services/types';
import { NotFoundError } from '@/server/services/types';
import { renderShareError, renderSharePage, shareHeaders } from './share-html';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: RouteContext<'/s/[token]'>) {
  const { token } = await ctx.params;
  const limit = shareViewLimiter.check(shareRateKey(req.headers, token));
  if (!limit.ok)
    return new Response(renderShareError({ status: 429, retryAfterSec: limit.retryAfterSec }), {
      status: 429,
      headers: shareHeaders({ 'retry-after': String(limit.retryAfterSec) }),
    });

  let viewer: Actor | null = null;
  try {
    viewer = await getActor();
  } catch {
    viewer = null; // auth unavailable: treat as anonymous
  }

  try {
    const shared = await resolveShareToken(getDb(), token, viewer);
    return new Response(renderSharePage(shared.doc, shared.designSystem, shared.frameIds), {
      status: 200,
      headers: shareHeaders(),
    });
  } catch (e) {
    if (!(e instanceof NotFoundError))
      console.error('[share] unexpected error', e instanceof Error ? e.name : typeof e);
    const signInHref = viewer
      ? undefined
      : `/sign-in?redirect_url=${encodeURIComponent(`/s/${token}`)}`;
    return new Response(renderShareError({ status: 404, signInHref }), {
      status: 404,
      headers: shareHeaders(),
    });
  }
}
