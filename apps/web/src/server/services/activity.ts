/**
 * Project activity (Story 6.4). Collab/export services write rows here; the feed merges them
 * with the doc_ops log so design edits (human vs. agent) appear without extra writes.
 */
import { activity, type Db } from '@crunch/db';
import type { Actor } from './types';

export type ActivityVerb =
  | 'comment.created'
  | 'comment.replied'
  | 'comment.resolved'
  | 'comment.reopened'
  | 'comment.agent_requested'
  | 'version.named'
  | 'version.restored'
  | 'share.created'
  | 'share.updated'
  | 'share.revoked'
  | 'export.created';

export interface ActivityInput {
  projectId: string;
  verb: ActivityVerb;
  targetType?: string;
  targetId?: string;
  data?: Record<string, unknown>;
  actorType?: 'user' | 'agent' | 'system';
}

/** Append an activity row. Callers have already authorized the underlying action. */
export async function recordActivity(db: Db, actor: Actor, input: ActivityInput): Promise<void> {
  await db.insert(activity).values({
    workspaceId: actor.workspace.id,
    projectId: input.projectId,
    actorType: input.actorType ?? 'user',
    actorId: actor.userId,
    verb: input.verb,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    data: input.data ?? {},
  });
}
