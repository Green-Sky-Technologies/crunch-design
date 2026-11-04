/**
 * Generation jobs from the chat (Story 5.5): "generate", "redesign" and "N alternatives".
 * The user starts one explicitly (SPEC §2.4); it gets an assistant message in the conversation
 * that its transactions are attributed to, and a job card that streams its events.
 */
import { assertCan } from '@crunch/authz';
import { ModelNotAllowedError, resolveModel } from '@crunch/agent';
import { agentConversations, agentMessages, and, eq, sql, type Db, type JobRow } from '@crunch/db';
import { z } from 'zod';
import { toMessageView, type MessageView, type StoredAssistantContent } from '../agent';
import { getDoc } from '../design-docs';
import { createJob } from '../jobs';
import { getProject } from '../projects';
import { NotFoundError, ValidationError, type Actor } from '../types';
import { getModelSettings } from './model-settings';

export const startGenerationInput = z
  .object({
    projectId: z.uuid(),
    conversationId: z.uuid().optional(),
    kind: z.enum(['generate', 'redesign', 'alternatives']),
    prompt: z.string().trim().max(20_000),
    frameIds: z.array(z.string().max(64)).max(20).optional(),
    count: z.number().int().min(2).max(5).optional(),
    frameCount: z.number().int().min(1).max(10).optional(),
    model: z.string().max(100).optional(),
  })
  .strict();

export async function startGenerationJob(
  db: Db,
  actor: Actor,
  raw: unknown,
): Promise<{ job: JobRow; message: MessageView }> {
  assertCan(actor.role, 'agent:run');
  const parsed = startGenerationInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid job');
  const i = parsed.data;
  await getProject(db, actor, i.projectId);
  let model: string;
  try {
    model = resolveModel(await getModelSettings(db, actor.workspace.id), 'generation', i.model);
  } catch (e) {
    if (e instanceof ModelNotAllowedError) throw new ValidationError(e.message);
    throw e;
  }

  const { doc } = await getDoc(db, actor, i.projectId);
  let input: unknown;
  if (i.kind === 'generate') {
    if (!i.prompt) throw new ValidationError('Describe what to generate');
    input = { prompt: i.prompt, frameCount: i.frameCount ?? 1 };
  } else if (i.kind === 'redesign') {
    const frameIds = i.frameIds?.length ? i.frameIds : doc.frames.slice(0, 1).map((f) => f.id);
    if (!frameIds.length) throw new ValidationError('There is no frame to redesign');
    if (!i.prompt) throw new ValidationError('Describe the redesign');
    input = { prompt: i.prompt, frameIds };
  } else {
    const frameId = i.frameIds?.[0] ?? doc.frames[0]?.id;
    if (!frameId) throw new ValidationError('There is no frame to make alternatives of');
    input = { prompt: i.prompt, frameId, count: i.count ?? 3 };
  }

  // Conversation + assistant message the job reports into.
  const { conversationId, messageId } = await db.transaction(async (tx) => {
    let conversationId = i.conversationId;
    if (conversationId) {
      const [c] = await tx
        .select({ id: agentConversations.id })
        .from(agentConversations)
        .where(
          and(
            eq(agentConversations.id, conversationId),
            eq(agentConversations.workspaceId, actor.workspace.id),
            eq(agentConversations.projectId, i.projectId),
          ),
        )
        .for('update')
        .limit(1);
      if (!c) throw new NotFoundError('Conversation not found');
    } else {
      const [c] = await tx
        .insert(agentConversations)
        .values({
          workspaceId: actor.workspace.id,
          projectId: i.projectId,
          title: (i.prompt || i.kind).slice(0, 80),
          createdBy: actor.userId,
        })
        .returning();
      conversationId = c!.id;
    }
    const [{ max }] = (await tx
      .select({ max: sql<number>`coalesce(max(${agentMessages.seq}), 0)::int` })
      .from(agentMessages)
      .where(eq(agentMessages.conversationId, conversationId))) as [{ max: number }];
    const content: StoredAssistantContent = { v: 1, turns: [] };
    const [m] = await tx
      .insert(agentMessages)
      .values({
        conversationId,
        workspaceId: actor.workspace.id,
        seq: max + 1,
        role: 'assistant',
        content,
        status: 'streaming',
        model,
        createdBy: actor.userId,
      })
      .returning();
    return { conversationId, messageId: m!.id };
  });

  const job = await createJob(db, actor, {
    kind: i.kind,
    input,
    projectId: i.projectId,
    conversationId,
    messageId,
  });
  const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, messageId));
  return { job, message: toMessageView(row!) };
}
