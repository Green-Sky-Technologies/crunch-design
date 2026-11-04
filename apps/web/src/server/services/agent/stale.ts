/**
 * Settle interactive replies whose function died mid-turn (time limit or crash), so the chat
 * doesn't show them as streaming forever. Job messages are settled by the job lifecycle.
 * Runs on read (chat load, message stream) and from the job reaper cron.
 */
import { agentMessages, and, eq, inArray, isNull, lt, type Db } from '@crunch/db';

/** Older than the longest possible turn (route maxDuration 300s) plus slack. */
export const STALE_TURN_MS = 6 * 60_000;
const INTERRUPTED_ERROR = 'The reply was interrupted. Try again.';

export async function settleStaleMessages(
  db: Db,
  opts: { conversationId?: string; messageId?: string; now?: Date } = {},
): Promise<number> {
  const cutoff = new Date((opts.now ?? new Date()).getTime() - STALE_TURN_MS);
  const rows = await db
    .update(agentMessages)
    .set({ status: 'error', error: INTERRUPTED_ERROR })
    .where(
      and(
        inArray(agentMessages.status, ['pending', 'streaming']),
        isNull(agentMessages.jobId),
        lt(agentMessages.createdAt, cutoff),
        opts.conversationId ? eq(agentMessages.conversationId, opts.conversationId) : undefined,
        opts.messageId ? eq(agentMessages.id, opts.messageId) : undefined,
      ),
    )
    .returning({ id: agentMessages.id });
  return rows.length;
}
