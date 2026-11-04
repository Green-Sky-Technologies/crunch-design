/**
 * "Ask the agent" for a scoped node edit (Story 5.7).
 * Producer: stream-agent implements POST {AGENT_EDIT_ENDPOINT}.
 * Consumer: stream-collab-export calls it from agent_request comment threads.
 * Until the agent stream merges, the endpoint returns 404; consumers show "not available yet".
 */
import { z } from 'zod';

export const AGENT_EDIT_ENDPOINT = '/api/agent/edit';

export const agentEditRequest = z
  .object({
    projectId: z.uuid(),
    frameId: z.string(),
    nodeId: z.string(),
    prompt: z.string().min(1).max(4000),
    /** The comment thread this request came from, if any. */
    commentThreadId: z.uuid().optional(),
    /** Allow edits outside the node's subtree (requires explicit user approval in the UI). */
    allowWiderScope: z.boolean().default(false),
  })
  .strict();
export type AgentEditRequest = z.infer<typeof agentEditRequest>;

export const agentEditResponse = z
  .object({
    conversationId: z.uuid(),
    messageId: z.uuid(),
    /** SSE stream for this message's progress. */
    streamUrl: z.string(),
  })
  .strict();
export type AgentEditResponse = z.infer<typeof agentEditResponse>;
