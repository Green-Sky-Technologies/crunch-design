/**
 * GET   /api/comments/:threadId  -> { thread }
 * PATCH /api/comments/:threadId  <- { status } | { fallback: {x,y} } | { agentConversationId }
 */
import { getDb } from '@crunch/db';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiActor, apiError, jsonBody } from '@/server/api';
import {
  getThread,
  linkAgentConversation,
  setThreadStatus,
  updateThreadFallback,
} from '@/server/services/comments';
import { ValidationError } from '@/server/services/types';

const patchBody = z.union([
  z.object({ status: z.enum(['open', 'resolved']) }).strict(),
  z.object({ fallback: z.unknown() }).strict(),
  z.object({ agentConversationId: z.unknown() }).strict(),
]);

export async function GET(_req: NextRequest, ctx: RouteContext<'/api/comments/[threadId]'>) {
  try {
    const actor = await apiActor();
    const { threadId } = await ctx.params;
    return NextResponse.json({ thread: await getThread(getDb(), actor, threadId) });
  } catch (e) {
    return apiError(e);
  }
}

export async function PATCH(req: NextRequest, ctx: RouteContext<'/api/comments/[threadId]'>) {
  try {
    const actor = await apiActor();
    const { threadId } = await ctx.params;
    const parsed = patchBody.safeParse(await jsonBody(req, 16 * 1024));
    if (!parsed.success) throw new ValidationError('Invalid update');
    const b = parsed.data;
    const db = getDb();
    if ('status' in b)
      return NextResponse.json({ thread: await setThreadStatus(db, actor, threadId, b.status) });
    if ('fallback' in b) {
      await updateThreadFallback(db, actor, threadId, b.fallback);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({
      thread: await linkAgentConversation(db, actor, threadId, b.agentConversationId),
    });
  } catch (e) {
    return apiError(e);
  }
}
