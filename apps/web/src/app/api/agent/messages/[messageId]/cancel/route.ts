/** POST /api/agent/messages/:id/cancel: stop a running reply (the turn aborts its model call). */
import { getDb } from '@crunch/db';
import { NextResponse } from 'next/server';
import { apiActor, apiError } from '@/server/api';
import { cancelMessage } from '@/server/services/agent';

export async function POST(
  _req: Request,
  ctx: RouteContext<'/api/agent/messages/[messageId]/cancel'>,
) {
  try {
    const actor = await apiActor();
    const { messageId } = await ctx.params;
    return NextResponse.json(await cancelMessage(getDb(), actor, messageId));
  } catch (e) {
    return apiError(e);
  }
}
