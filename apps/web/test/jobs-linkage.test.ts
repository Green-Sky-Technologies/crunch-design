/** A job can only report into an unlinked assistant message of its own project (review #6). */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agentConversations, agentMessages, jobs } from '@crunch/db';
import { createJob } from '@/server/services/jobs';
import { createProject } from '@/server/services/projects';
import { ValidationError, type Actor } from '@/server/services/types';
import { makeActor, reset, testDb } from './helpers';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

async function conversationWith(
  actor: Actor,
  projectId: string,
  role: 'assistant' | 'user' = 'assistant',
) {
  const [conv] = await db
    .insert(agentConversations)
    .values({ workspaceId: actor.workspace.id, projectId, createdBy: actor.userId })
    .returning();
  const [msg] = await db
    .insert(agentMessages)
    .values({
      conversationId: conv!.id,
      workspaceId: actor.workspace.id,
      seq: 1,
      role,
      content: {},
    })
    .returning();
  return { conversationId: conv!.id, messageId: msg!.id };
}

const job = (projectId: string, link: { conversationId?: string; messageId?: string }) => ({
  kind: 'generate',
  input: { prompt: 'x', frameCount: 1 },
  projectId,
  ...link,
});

describe('job ↔ message linkage', () => {
  it('links an unlinked assistant message of the same project', async () => {
    const editor = await makeActor(db, 'editor');
    const p = await createProject(db, editor, { name: 'P' });
    const link = await conversationWith(editor, p.id);
    const created = await createJob(db, editor, job(p.id, link));
    expect(created.conversationId).toBe(link.conversationId);
  });

  it('rejects messages from another project, user messages, already-linked messages and mismatched conversations', async () => {
    const editor = await makeActor(db, 'editor');
    const p1 = await createProject(db, editor, { name: 'P1' });
    const p2 = await createProject(db, editor, { name: 'P2' });
    const other = await conversationWith(editor, p2.id);
    const userMsg = await conversationWith(editor, p1.id, 'user');
    const mine = await conversationWith(editor, p1.id);
    const second = await conversationWith(editor, p1.id);

    const bad = [
      job(p1.id, { messageId: other.messageId }), // another project's message
      job(p1.id, { conversationId: other.conversationId }), // another project's conversation
      job(p1.id, { messageId: userMsg.messageId }), // not an assistant message
      job(p1.id, { conversationId: second.conversationId, messageId: mine.messageId }), // wrong conversation
    ];
    for (const b of bad)
      await expect(createJob(db, editor, b)).rejects.toBeInstanceOf(ValidationError);

    await createJob(db, editor, job(p1.id, mine));
    await expect(createJob(db, editor, job(p1.id, mine))).rejects.toThrow(/not linked to a job/);
    // Rejected requests left no job rows behind.
    expect(await db.select().from(jobs)).toHaveLength(1);
  });

  it('rejects links without a project, and links across workspaces', async () => {
    const editor = await makeActor(db, 'editor');
    const p = await createProject(db, editor, { name: 'P' });
    const link = await conversationWith(editor, p.id);
    await expect(
      createJob(db, editor, {
        kind: 'generate',
        input: { prompt: 'x' },
        messageId: link.messageId,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const stranger = await makeActor(db, 'editor');
    const theirs = await createProject(db, stranger, { name: 'Theirs' });
    await expect(createJob(db, stranger, job(theirs.id, link))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
