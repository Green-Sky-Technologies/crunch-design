/**
 * GET /api/agent/messages/:id/stream: SSE of one agent message's progress.
 * Events: `message` (full MessageView on every change), then `done`. Reconnects get the current
 * state first, so no Last-Event-ID bookkeeping is needed here (job streams do use it).
 */
import { getDb } from '@crunch/db';
import { sseStream, SSE_HEADERS } from '@crunch/agent';
import { apiActor, apiError } from '@/server/api';
import { getMessageView, messageEvents } from '@/server/services/agent';

export const maxDuration = 300;

export async function GET(
  req: Request,
  ctx: RouteContext<'/api/agent/messages/[messageId]/stream'>,
) {
  try {
    const actor = await apiActor();
    const { messageId } = await ctx.params;
    await getMessageView(getDb(), actor, messageId); // 404 before opening the stream
    const frames = messageEvents(getDb(), actor, messageId, { signal: req.signal });
    return new Response(sseStream(frames, req.signal), { headers: SSE_HEADERS });
  } catch (e) {
    return apiError(e);
  }
}
