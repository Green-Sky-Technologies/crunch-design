/**
 * POST /api/agent/messages/:id/answer <- { answers: [{ questionId, optionIds, other? }], skip?, model? }
 *                                     -> { conversationId, userMessageId, messageId, streamUrl }
 * Answers the follow-up questions an agent reply asked (or skips them: "just decide"). The
 * agent continues in a new reply, followed on streamUrl (SSE). When that reply suggests a
 * generation job, the job starts right away. Requires agent:run.
 */
import { getDb } from '@crunch/db';
import { after, NextResponse } from 'next/server';
import { apiActor, apiError, jsonBody } from '@/server/api';
import { answerQuestions, messageStreamUrl, runAssistantMessage } from '@/server/services/agent';
import { startGenerationJob } from '@/server/services/agent/generation';
import { jobRunner } from '@/server/services/agent/runner';
import { startJob } from '@/server/services/jobs';

export const maxDuration = 300;

export async function POST(
  req: Request,
  ctx: RouteContext<'/api/agent/messages/[messageId]/answer'>,
) {
  try {
    const actor = await apiActor();
    const { messageId } = await ctx.params;
    const db = getDb();
    const sent = await answerQuestions(db, actor, messageId, await jsonBody(req, 64 * 1024));
    after(async () => {
      const running: Promise<unknown>[] = [];
      await runAssistantMessage(db, actor, sent.messageId, {
        startJob: async (s, at) => {
          const { job, message } = await startGenerationJob(db, actor, {
            projectId: at.projectId,
            conversationId: at.conversationId,
            kind: s.kind,
            prompt: s.prompt,
            frameIds: s.frameIds,
            count: s.count,
          });
          running.push(startJob(db, job.id, { runner: jobRunner(db) }));
          return { jobId: job.id, messageId: message.id };
        },
      });
      await Promise.all(running);
    });
    return NextResponse.json({ ...sent, streamUrl: messageStreamUrl(sent.messageId) });
  } catch (e) {
    return apiError(e);
  }
}
