/**
 * Scoped "ask the agent" edits (Story 5.7, backend): implements the requestAgentEdit contract
 * (packages/contracts/src/agent-edit.ts) behind POST /api/agent/edit.
 *
 * The request carries only the target node's subtree and the design system (the cached prefix).
 * Patches outside that subtree are rejected by the tool host unless `allowWiderScope` is set,
 * which the UI only sends after the user approves a wider change. Follow-ups from the same
 * comment thread continue the same conversation.
 */
import { agentEditRequest, type AgentEditResponse } from '@crunch/contracts';
import { assertCan } from '@crunch/authz';
import { agentConversations, and, desc, eq, type Db } from '@crunch/db';
import { frameOf } from '@crunch/doc-model';
import { messageStreamUrl, sendMessage, type SentMessage } from '../agent';
import { getDoc } from '../design-docs';
import { NotFoundError, ValidationError, type Actor } from '../types';

export async function requestAgentEdit(
  db: Db,
  actor: Actor,
  raw: unknown,
): Promise<AgentEditResponse & { needsRun: boolean }> {
  assertCan(actor.role, 'agent:run');
  const parsed = agentEditRequest.safeParse(raw);
  if (!parsed.success)
    throw new ValidationError(
      `Invalid request: ${parsed.error.issues[0]?.path.join('.') ?? ''} ${parsed.error.issues[0]?.message ?? ''}`.trim(),
    );
  const req = parsed.data;
  const { doc } = await getDoc(db, actor, req.projectId); // also checks workspace scoping
  if (!doc.nodes[req.nodeId]) throw new NotFoundError('That element no longer exists');
  if (frameOf(doc, req.nodeId)?.id !== req.frameId)
    throw new ValidationError('The element is not in that frame');

  let conversationId: string | undefined;
  if (req.commentThreadId) {
    const [conv] = await db
      .select()
      .from(agentConversations)
      .where(
        and(
          eq(agentConversations.workspaceId, actor.workspace.id),
          eq(agentConversations.projectId, req.projectId),
          eq(agentConversations.commentThreadId, req.commentThreadId),
        ),
      )
      .orderBy(desc(agentConversations.createdAt))
      .limit(1);
    const scope = conv?.scope as { nodeId?: string } | null | undefined;
    if (conv && scope?.nodeId === req.nodeId) {
      conversationId = conv.id;
      // Approval for a wider change applies to this request onward.
      await db
        .update(agentConversations)
        .set({
          scope: { nodeId: req.nodeId, frameId: req.frameId, allowWider: req.allowWiderScope },
        })
        .where(eq(agentConversations.id, conv.id));
    }
  }

  const sent: SentMessage = await sendMessage(
    db,
    actor,
    { projectId: req.projectId, conversationId, prompt: req.prompt },
    {
      scope: { scopeNodeId: req.nodeId, frameId: req.frameId, allowWider: req.allowWiderScope },
      commentThreadId: req.commentThreadId,
    },
  );
  return {
    conversationId: sent.conversationId,
    messageId: sent.messageId,
    streamUrl: messageStreamUrl(sent.messageId),
    needsRun: sent.needsRun,
  };
}
