/**
 * Request control of a project's edit lock (Story 3.8).
 *
 * POST   /api/projects/:id/lock/request  <- { sessionId }  -> LockState  (ask the holder)
 * DELETE /api/projects/:id/lock/request?sessionId=…        -> LockState  (holder declines)
 */
import { getDb } from '@crunch/db';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiActor, apiError, jsonBody } from '@/server/api';
import { declineRequest, requestControl } from '@/server/services/locks';
import { ValidationError } from '@/server/services/types';

const body = z.object({ sessionId: z.string().max(64) }).strict();

export async function POST(
  req: NextRequest,
  ctx: RouteContext<'/api/projects/[projectId]/lock/request'>,
) {
  try {
    const actor = await apiActor();
    const { projectId } = await ctx.params;
    const r = body.safeParse(await jsonBody(req, 4096));
    if (!r.success) throw new ValidationError('Expected { sessionId }');
    return NextResponse.json(await requestControl(getDb(), actor, projectId, r.data));
  } catch (e) {
    return apiError(e);
  }
}

export async function DELETE(
  req: NextRequest,
  ctx: RouteContext<'/api/projects/[projectId]/lock/request'>,
) {
  try {
    const actor = await apiActor();
    const { projectId } = await ctx.params;
    const sessionId = req.nextUrl.searchParams.get('sessionId');
    return NextResponse.json(await declineRequest(getDb(), actor, projectId, { sessionId }));
  } catch (e) {
    return apiError(e);
  }
}
