/**
 * Soft edit lock and presence (Story 3.8).
 *
 * GET    /api/projects/:id/lock?sessionId=…                 -> LockState
 * POST   /api/projects/:id/lock     <- { sessionId }        -> { acquired, state }   (acquire)
 * PUT    /api/projects/:id/lock     <- { sessionId }        -> LockState             (heartbeat)
 * DELETE /api/projects/:id/lock?sessionId=…[&handoff=1][&leave=1] -> LockState      (release)
 *
 * Request control and admin take-over live under ./request and ./takeover.
 */
import { getDb } from '@crunch/db';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiActor, apiError, jsonBody } from '@/server/api';
import { acquireLock, getLockState, heartbeat, releaseLock } from '@/server/services/locks';
import { ValidationError } from '@/server/services/types';

const body = z.object({ sessionId: z.string().max(64) }).strict();

async function parse(req: NextRequest) {
  const r = body.safeParse(await jsonBody(req, 4096));
  if (!r.success) throw new ValidationError('Expected { sessionId }');
  return r.data;
}

export async function GET(req: NextRequest, ctx: RouteContext<'/api/projects/[projectId]/lock'>) {
  try {
    const actor = await apiActor();
    const { projectId } = await ctx.params;
    const sessionId = req.nextUrl.searchParams.get('sessionId') ?? undefined;
    return NextResponse.json(await getLockState(getDb(), actor, projectId, sessionId));
  } catch (e) {
    return apiError(e);
  }
}

export async function POST(req: NextRequest, ctx: RouteContext<'/api/projects/[projectId]/lock'>) {
  try {
    const actor = await apiActor();
    const { projectId } = await ctx.params;
    return NextResponse.json(await acquireLock(getDb(), actor, projectId, await parse(req)));
  } catch (e) {
    return apiError(e);
  }
}

export async function PUT(req: NextRequest, ctx: RouteContext<'/api/projects/[projectId]/lock'>) {
  try {
    const actor = await apiActor();
    const { projectId } = await ctx.params;
    return NextResponse.json(await heartbeat(getDb(), actor, projectId, await parse(req)));
  } catch (e) {
    return apiError(e);
  }
}

export async function DELETE(
  req: NextRequest,
  ctx: RouteContext<'/api/projects/[projectId]/lock'>,
) {
  try {
    const actor = await apiActor();
    const { projectId } = await ctx.params;
    const q = req.nextUrl.searchParams;
    return NextResponse.json(
      await releaseLock(getDb(), actor, projectId, {
        sessionId: q.get('sessionId'),
        handoff: q.get('handoff') === '1',
        leave: q.get('leave') === '1',
      }),
    );
  } catch (e) {
    return apiError(e);
  }
}
