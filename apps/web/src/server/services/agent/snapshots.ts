/**
 * Auto snapshots before agent edits (Story 5.12). Every agent message takes one snapshot right
 * before its first transaction (later transactions of the same message are covered by it), and
 * links it from agent_messages.snapshotVersionId. "Revert agent change" restores that snapshot
 * in the editor as a normal, undoable doc-store transaction.
 */
import { assertCan } from '@crunch/authz';
import { agentConversations, agentMessages, and, eq, isNull, type Db } from '@crunch/db';
import type { DesignDoc } from '@crunch/doc-model';
import { z } from 'zod';
import { createSnapshot, getSnapshotDoc } from '../snapshots';
import { NotFoundError, ValidationError, type Actor } from '../types';

/** Take the auto snapshot for a message (idempotent: only the first call snapshots). */
export async function snapshotBeforeAgentEdit(
  db: Db,
  actor: Actor,
  projectId: string,
  messageId: string,
): Promise<string> {
  const [msg] = await db
    .select({ snapshot: agentMessages.snapshotVersionId })
    .from(agentMessages)
    .where(eq(agentMessages.id, messageId));
  if (msg?.snapshot) return msg.snapshot;
  const snap = await createSnapshot(db, actor, projectId, {
    kind: 'auto',
    description: 'Before agent change',
    agentMessageId: messageId,
  });
  await db
    .update(agentMessages)
    .set({ snapshotVersionId: snap.id })
    .where(and(eq(agentMessages.id, messageId), isNull(agentMessages.snapshotVersionId)));
  return snap.id;
}

/** The snapshot a message's edits can be reverted to, for the editor to apply. */
export async function getRevertTarget(
  db: Db,
  actor: Actor,
  messageId: string,
): Promise<{ snapshotId: string; doc: DesignDoc }> {
  assertCan(actor.role, 'design:edit');
  const [row] = z.uuid().safeParse(messageId).success
    ? await db
        .select({
          snapshot: agentMessages.snapshotVersionId,
          projectId: agentConversations.projectId,
        })
        .from(agentMessages)
        .innerJoin(agentConversations, eq(agentConversations.id, agentMessages.conversationId))
        .where(
          and(eq(agentMessages.id, messageId), eq(agentMessages.workspaceId, actor.workspace.id)),
        )
    : [];
  if (!row) throw new NotFoundError('Message not found');
  if (!row.snapshot) throw new ValidationError('This message made no changes to revert');
  const { summary, doc } = await getSnapshotDoc(db, actor, row.projectId, row.snapshot);
  return { snapshotId: summary.id, doc };
}
