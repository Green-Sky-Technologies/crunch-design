/**
 * POST /api/agent/messages  <- { projectId, conversationId?, prompt, model?, selection?, frameId?, attachments? }
 *                           -> { conversationId, userMessageId, messageId, streamUrl }
 * The reply runs after the response; follow it on streamUrl (SSE). Requires agent:run.
 */
import { getDb } from '@crunch/db';
import { after, NextResponse } from 'next/server';
import { apiActor, apiError, jsonBody } from '@/server/api';
import { messageStreamUrl, runAssistantMessage, sendMessage } from '@/server/services/agent';

export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const actor = await apiActor();
    const sent = await sendMessage(getDb(), actor, await jsonBody(req, 512 * 1024));
    if (sent.needsRun)
      after(() => runAssistantMessage(getDb(), actor, sent.messageId).then(() => undefined));
    return NextResponse.json({ ...sent, streamUrl: messageStreamUrl(sent.messageId) });
  } catch (e) {
    return apiError(e);
  }
}
