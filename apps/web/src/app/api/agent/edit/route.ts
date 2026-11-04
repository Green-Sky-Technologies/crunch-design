/**
 * POST /api/agent/edit: the requestAgentEdit contract (Story 5.7, @crunch/contracts agent-edit).
 *   <- AgentEditRequest { projectId, frameId, nodeId, prompt, commentThreadId?, allowWiderScope? }
 *   -> AgentEditResponse { conversationId, messageId, streamUrl }
 * The edit runs after the response; follow it on streamUrl (SSE). Requires agent:run.
 */
import { agentEditResponse } from '@crunch/contracts';
import { getDb } from '@crunch/db';
import { after, NextResponse } from 'next/server';
import { apiActor, apiError, jsonBody } from '@/server/api';
import { runAssistantMessage } from '@/server/services/agent';
import { requestAgentEdit } from '@/server/services/agent/edit';

export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const actor = await apiActor();
    const { needsRun, ...res } = await requestAgentEdit(
      getDb(),
      actor,
      await jsonBody(req, 64 * 1024),
    );
    if (needsRun)
      after(() => runAssistantMessage(getDb(), actor, res.messageId).then(() => undefined));
    return NextResponse.json(agentEditResponse.parse(res));
  } catch (e) {
    return apiError(e);
  }
}
