/**
 * GET  /api/share?projectId=…  -> { links }
 * POST /api/share  <- { projectId, visibility?, expiresAt?, frameIds?, docVersionId? }
 *                  -> { link, token, path }   (the token is returned only here, once)
 */
import { getDb } from '@crunch/db';
import { NextResponse, type NextRequest } from 'next/server';
import { apiActor, apiError, jsonBody } from '@/server/api';
import { createShareLink, listShareLinks } from '@/server/services/share-links';
import { NotFoundError } from '@/server/services/types';

export async function GET(req: NextRequest) {
  try {
    const actor = await apiActor();
    const projectId = req.nextUrl.searchParams.get('projectId');
    if (!projectId) throw new NotFoundError('Project not found');
    return NextResponse.json({ links: await listShareLinks(getDb(), actor, projectId) });
  } catch (e) {
    return apiError(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await apiActor();
    const created = await createShareLink(getDb(), actor, await jsonBody(req, 16 * 1024));
    return NextResponse.json(created, {
      status: 201,
      headers: { 'cache-control': 'no-store' },
    });
  } catch (e) {
    return apiError(e);
  }
}
