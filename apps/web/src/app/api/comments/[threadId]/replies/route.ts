/** POST /api/comments/:threadId/replies  <- { body, mentions? }  -> { thread } */
import { getDb } from '@crunch/db';
import { NextResponse, type NextRequest } from 'next/server';
import { apiActor, apiError, jsonBody } from '@/server/api';
import { replyToThread } from '@/server/services/comments';

export async function POST(
  req: NextRequest,
  ctx: RouteContext<'/api/comments/[threadId]/replies'>,
) {
  try {
    const actor = await apiActor();
    const { threadId } = await ctx.params;
    const thread = await replyToThread(getDb(), actor, threadId, await jsonBody(req, 64 * 1024));
    return NextResponse.json({ thread }, { status: 201 });
  } catch (e) {
    return apiError(e);
  }
}
