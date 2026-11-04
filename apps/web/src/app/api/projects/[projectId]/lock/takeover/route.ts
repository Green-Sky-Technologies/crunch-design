/**
 * Admin take-over of a project's edit lock (Story 3.8).
 *
 * POST /api/projects/:id/lock/takeover  <- { sessionId }  -> LockState   (403 unless admin)
 */
import { getDb } from '@crunch/db';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiActor, apiError, jsonBody } from '@/server/api';
import { takeOver } from '@/server/services/locks';
import { ValidationError } from '@/server/services/types';

const body = z.object({ sessionId: z.string().max(64) }).strict();

export async function POST(
  req: NextRequest,
  ctx: RouteContext<'/api/projects/[projectId]/lock/takeover'>,
) {
  try {
    const actor = await apiActor();
    const { projectId } = await ctx.params;
    const r = body.safeParse(await jsonBody(req, 4096));
    if (!r.success) throw new ValidationError('Expected { sessionId }');
    return NextResponse.json(await takeOver(getDb(), actor, projectId, r.data));
  } catch (e) {
    return apiError(e);
  }
}
