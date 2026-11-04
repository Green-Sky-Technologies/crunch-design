/**
 * PATCH  /api/share/:linkId  <- { visibility?, expiresAt? (ISO or null) }  -> { link }
 * DELETE /api/share/:linkId  -> { link }   (revokes; the row is kept for audit)
 */
import { getDb } from '@crunch/db';
import { NextResponse, type NextRequest } from 'next/server';
import { apiActor, apiError, jsonBody } from '@/server/api';
import { revokeShareLink, updateShareLink } from '@/server/services/share-links';

export async function PATCH(req: NextRequest, ctx: RouteContext<'/api/share/[linkId]'>) {
  try {
    const actor = await apiActor();
    const { linkId } = await ctx.params;
    const link = await updateShareLink(getDb(), actor, linkId, await jsonBody(req, 4 * 1024));
    return NextResponse.json({ link });
  } catch (e) {
    return apiError(e);
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext<'/api/share/[linkId]'>) {
  try {
    const actor = await apiActor();
    const { linkId } = await ctx.params;
    return NextResponse.json({ link: await revokeShareLink(getDb(), actor, linkId) });
  } catch (e) {
    return apiError(e);
  }
}
