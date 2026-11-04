/**
 * Comment threads (Story 6.1) and ask-agent threads (Story 5.7, UI side).
 *
 * - A thread is anchored to a node (`{ type: 'node', frameId, nodeId, offset? }`) or to a canvas
 *   position (`{ type: 'canvas', x, y }`). Node anchors reference the stable node id, so threads
 *   follow the node when it moves or is restyled.
 * - `fallback` is the last known canvas position. When the node is deleted, the thread is
 *   reported as `orphaned` and the UI shows it at the fallback position: it stays visible.
 * - @mentions are validated against workspace members and create in-app notifications.
 * - Reading needs project:read; writing needs design:comment (viewers can't comment);
 *   agent_request threads also need agent:run.
 */
import { assertCan } from '@crunch/authz';
import {
  and,
  asc,
  commentThreads,
  comments,
  desc,
  eq,
  inArray,
  isNull,
  members,
  notifications,
  users,
  type CommentRow,
  type CommentThreadRow,
  type Db,
} from '@crunch/db';
import { id as nodeIdSchema, type DesignDoc, type Node } from '@crunch/doc-model';
import { z } from 'zod';
import { recordActivity } from './activity';
import { getDoc } from './design-docs';
import { getProject } from './projects';
import { NotFoundError, ValidationError, type Actor } from './types';

const point = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();

export const commentAnchor = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('node'),
      frameId: nodeIdSchema,
      nodeId: nodeIdSchema,
      offset: point.optional(),
    })
    .strict(),
  z.object({ type: z.literal('canvas'), x: z.number().finite(), y: z.number().finite() }).strict(),
]);
export type CommentAnchor = z.infer<typeof commentAnchor>;
export type CanvasPoint = z.infer<typeof point>;

const body = z.string().trim().min(1, 'Write a comment').max(5000);
const mentionList = z.array(z.string().min(1).max(64)).max(20).default([]);

const createThreadInput = z
  .object({
    projectId: z.string(),
    anchor: commentAnchor,
    body,
    mentions: mentionList,
    kind: z.enum(['discussion', 'agent_request']).default('discussion'),
    /** Canvas position of the anchor when created (client-measured); used if the node is deleted. */
    fallback: point.optional(),
  })
  .strict();

const replyInput = z.object({ body, mentions: mentionList }).strict();

export interface CommentView {
  id: string;
  authorType: CommentRow['authorType'];
  authorId: string;
  authorName: string | null;
  body: string;
  mentions: string[];
  createdAt: Date;
}

export interface ThreadView {
  id: string;
  projectId: string;
  kind: CommentThreadRow['kind'];
  status: CommentThreadRow['status'];
  anchor: CommentAnchor;
  fallback: CanvasPoint | null;
  /** Node anchor whose node no longer exists in the current doc. */
  orphaned: boolean;
  agentConversationId: string | null;
  createdBy: string;
  createdAt: Date;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  comments: CommentView[];
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of r.error.issues) {
      const k = issue.path.join('.') || '_';
      (fieldErrors[k] ??= []).push(issue.message);
    }
    throw new ValidationError(r.error.issues[0]?.message ?? 'Invalid input', fieldErrors);
  }
  return r.data;
}

/** True if `nodeId` exists and belongs to `frameId`'s tree. */
export function nodeInFrame(doc: DesignDoc, frameId: string, nodeId: string): boolean {
  const frame = doc.frames.find((f) => f.id === frameId);
  if (!frame) return false;
  let cur: Node | undefined = doc.nodes[nodeId];
  for (let i = 0; cur && i < 10_000; i++) {
    if (cur.id === frame.rootNodeId) return true;
    cur = cur.parentId ? doc.nodes[cur.parentId] : undefined;
  }
  return false;
}

function isOrphaned(doc: DesignDoc, anchor: CommentAnchor): boolean {
  return anchor.type === 'node' && !nodeInFrame(doc, anchor.frameId, anchor.nodeId);
}

/** Workspace members a comment may mention (for autocomplete and validation). */
export async function listMentionableMembers(
  db: Db,
  actor: Actor,
): Promise<
  { userId: string; name: string | null; email: string | null; imageUrl: string | null }[]
> {
  assertCan(actor.role, 'project:read');
  return db
    .select({
      userId: members.userId,
      name: users.name,
      email: users.email,
      imageUrl: users.imageUrl,
    })
    .from(members)
    .leftJoin(users, eq(users.id, members.userId))
    .where(eq(members.workspaceId, actor.workspace.id))
    .orderBy(asc(users.name), asc(members.userId))
    .limit(500);
}

/** Keep only mentions of real workspace members, minus the author. */
async function validMentions(db: Db, actor: Actor, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)].filter((id) => id !== actor.userId);
  if (!unique.length) return [];
  const rows = await db
    .select({ userId: members.userId })
    .from(members)
    .where(and(eq(members.workspaceId, actor.workspace.id), inArray(members.userId, unique)));
  const ok = new Set(rows.map((r) => r.userId));
  return unique.filter((id) => ok.has(id));
}

async function notifyMentions(
  db: Db,
  actor: Actor,
  args: { projectId: string; threadId: string; commentId: string; body: string; ids: string[] },
) {
  if (!args.ids.length) return;
  await db.insert(notifications).values(
    args.ids.map((userId) => ({
      workspaceId: actor.workspace.id,
      userId,
      kind: 'mention',
      projectId: args.projectId,
      data: {
        threadId: args.threadId,
        commentId: args.commentId,
        by: actor.userId,
        excerpt: args.body.slice(0, 200),
      },
    })),
  );
}

async function getThreadRow(db: Db, actor: Actor, threadId: string): Promise<CommentThreadRow> {
  assertCan(actor.role, 'project:read');
  if (!z.uuid().safeParse(threadId).success) throw new NotFoundError('Thread not found');
  const [row] = await db
    .select()
    .from(commentThreads)
    .where(and(eq(commentThreads.id, threadId), eq(commentThreads.workspaceId, actor.workspace.id)))
    .limit(1);
  if (!row) throw new NotFoundError('Thread not found');
  return row;
}

async function hydrate(db: Db, threads: CommentThreadRow[], doc: DesignDoc): Promise<ThreadView[]> {
  if (!threads.length) return [];
  const rows = await db
    .select({
      id: comments.id,
      threadId: comments.threadId,
      authorType: comments.authorType,
      authorId: comments.authorId,
      authorName: users.name,
      authorEmail: users.email,
      body: comments.body,
      mentions: comments.mentions,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .leftJoin(users, eq(users.id, comments.authorId))
    .where(
      and(
        inArray(
          comments.threadId,
          threads.map((t) => t.id),
        ),
        isNull(comments.deletedAt),
      ),
    )
    .orderBy(asc(comments.createdAt), asc(comments.id));
  const byThread = new Map<string, CommentView[]>();
  for (const r of rows) {
    const list = byThread.get(r.threadId) ?? [];
    list.push({
      id: r.id,
      authorType: r.authorType,
      authorId: r.authorId,
      authorName: r.authorName ?? r.authorEmail ?? null,
      body: r.body,
      mentions: r.mentions,
      createdAt: r.createdAt,
    });
    byThread.set(r.threadId, list);
  }
  return threads.map((t) => {
    const anchor = commentAnchor.parse(t.anchor);
    const fb = point.safeParse(t.fallback);
    return {
      id: t.id,
      projectId: t.projectId,
      kind: t.kind,
      status: t.status,
      anchor,
      fallback: fb.success ? fb.data : null,
      orphaned: isOrphaned(doc, anchor),
      agentConversationId: t.agentConversationId,
      createdBy: t.createdBy,
      createdAt: t.createdAt,
      resolvedBy: t.resolvedBy,
      resolvedAt: t.resolvedAt,
      comments: byThread.get(t.id) ?? [],
    };
  });
}

export async function listThreads(
  db: Db,
  actor: Actor,
  projectId: string,
  opts: { status?: 'open' | 'resolved' } = {},
): Promise<ThreadView[]> {
  assertCan(actor.role, 'project:read');
  const { doc } = await getDoc(db, actor, projectId); // also scopes the project to the workspace
  const threads = await db
    .select()
    .from(commentThreads)
    .where(
      and(
        eq(commentThreads.projectId, projectId),
        eq(commentThreads.workspaceId, actor.workspace.id),
        opts.status ? eq(commentThreads.status, opts.status) : undefined,
      ),
    )
    .orderBy(desc(commentThreads.createdAt))
    .limit(500);
  return hydrate(db, threads, doc);
}

export async function getThread(db: Db, actor: Actor, threadId: string): Promise<ThreadView> {
  const row = await getThreadRow(db, actor, threadId);
  const { doc } = await getDoc(db, actor, row.projectId);
  return (await hydrate(db, [row], doc))[0]!;
}

export async function createThread(db: Db, actor: Actor, input: unknown): Promise<ThreadView> {
  assertCan(actor.role, 'design:comment');
  const data = parse(createThreadInput, input);
  if (data.kind === 'agent_request') assertCan(actor.role, 'agent:run');
  const project = await getProject(db, actor, data.projectId);
  const { doc } = await getDoc(db, actor, project.id);

  let fallback: CanvasPoint;
  if (data.anchor.type === 'node') {
    const { frameId, nodeId } = data.anchor;
    if (!nodeInFrame(doc, frameId, nodeId))
      throw new ValidationError('That element no longer exists', { anchor: ['Unknown node'] });
    const frame = doc.frames.find((f) => f.id === frameId)!;
    fallback = data.fallback ?? { x: frame.canvas.x, y: frame.canvas.y };
  } else {
    fallback = { x: data.anchor.x, y: data.anchor.y };
  }
  const mentions = await validMentions(db, actor, data.mentions);

  const { thread, comment } = await db.transaction(async (tx) => {
    const [thread] = await tx
      .insert(commentThreads)
      .values({
        workspaceId: actor.workspace.id,
        projectId: project.id,
        kind: data.kind,
        anchor: data.anchor,
        fallback,
        createdBy: actor.userId,
      })
      .returning();
    const [comment] = await tx
      .insert(comments)
      .values({
        threadId: thread!.id,
        workspaceId: actor.workspace.id,
        authorId: actor.userId,
        body: data.body,
        mentions,
      })
      .returning();
    return { thread: thread!, comment: comment! };
  });
  await notifyMentions(db, actor, {
    projectId: project.id,
    threadId: thread.id,
    commentId: comment.id,
    body: data.body,
    ids: mentions,
  });
  await recordActivity(db, actor, {
    projectId: project.id,
    verb: data.kind === 'agent_request' ? 'comment.agent_requested' : 'comment.created',
    targetType: 'comment_thread',
    targetId: thread.id,
    data: { excerpt: data.body.slice(0, 140) },
  });
  return (await hydrate(db, [thread], doc))[0]!;
}

export async function replyToThread(
  db: Db,
  actor: Actor,
  threadId: string,
  input: unknown,
): Promise<ThreadView> {
  assertCan(actor.role, 'design:comment');
  const data = parse(replyInput, input);
  const thread = await getThreadRow(db, actor, threadId);
  const mentions = await validMentions(db, actor, data.mentions);
  const [comment] = await db
    .insert(comments)
    .values({
      threadId: thread.id,
      workspaceId: actor.workspace.id,
      authorId: actor.userId,
      body: data.body,
      mentions,
    })
    .returning();
  await db
    .update(commentThreads)
    .set({ updatedAt: new Date() })
    .where(eq(commentThreads.id, thread.id));
  await notifyMentions(db, actor, {
    projectId: thread.projectId,
    threadId: thread.id,
    commentId: comment!.id,
    body: data.body,
    ids: mentions,
  });
  await recordActivity(db, actor, {
    projectId: thread.projectId,
    verb: 'comment.replied',
    targetType: 'comment_thread',
    targetId: thread.id,
    data: { excerpt: data.body.slice(0, 140) },
  });
  return getThread(db, actor, thread.id);
}

export async function setThreadStatus(
  db: Db,
  actor: Actor,
  threadId: string,
  status: 'open' | 'resolved',
): Promise<ThreadView> {
  assertCan(actor.role, 'design:comment');
  const s = parse(z.enum(['open', 'resolved']), status);
  const thread = await getThreadRow(db, actor, threadId);
  if (thread.status !== s) {
    await db
      .update(commentThreads)
      .set(
        s === 'resolved'
          ? { status: s, resolvedBy: actor.userId, resolvedAt: new Date() }
          : { status: s, resolvedBy: null, resolvedAt: null },
      )
      .where(eq(commentThreads.id, thread.id));
    await recordActivity(db, actor, {
      projectId: thread.projectId,
      verb: s === 'resolved' ? 'comment.resolved' : 'comment.reopened',
      targetType: 'comment_thread',
      targetId: thread.id,
    });
  }
  return getThread(db, actor, thread.id);
}

/** Update the remembered canvas position of a node-anchored thread (client re-measures it). */
export async function updateThreadFallback(
  db: Db,
  actor: Actor,
  threadId: string,
  fallback: unknown,
): Promise<void> {
  assertCan(actor.role, 'design:comment');
  const p = parse(point, fallback);
  const thread = await getThreadRow(db, actor, threadId);
  await db.update(commentThreads).set({ fallback: p }).where(eq(commentThreads.id, thread.id));
}

/** Link an ask-agent thread to the agent conversation handling it (Story 5.7). */
export async function linkAgentConversation(
  db: Db,
  actor: Actor,
  threadId: string,
  conversationId: unknown,
): Promise<ThreadView> {
  assertCan(actor.role, 'design:comment');
  assertCan(actor.role, 'agent:run');
  const cid = parse(z.uuid(), conversationId);
  const thread = await getThreadRow(db, actor, threadId);
  if (thread.kind !== 'agent_request')
    throw new ValidationError('Only ask-agent threads can link a conversation');
  await db
    .update(commentThreads)
    .set({ agentConversationId: cid })
    .where(eq(commentThreads.id, thread.id));
  return getThread(db, actor, thread.id);
}

// ---------------------------------------------------------------------------------------------
// Notifications (mentions). Always scoped to the caller's own user id and workspace.
// ---------------------------------------------------------------------------------------------

export interface NotificationView {
  id: string;
  kind: string;
  projectId: string | null;
  data: Record<string, unknown>;
  readAt: Date | null;
  createdAt: Date;
}

export async function listNotifications(
  db: Db,
  actor: Actor,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<NotificationView[]> {
  assertCan(actor.role, 'workspace:read');
  const rows = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.workspaceId, actor.workspace.id),
        eq(notifications.userId, actor.userId),
        opts.unreadOnly ? isNull(notifications.readAt) : undefined,
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(Math.min(opts.limit ?? 50, 200));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    projectId: r.projectId,
    data: (r.data ?? {}) as Record<string, unknown>,
    readAt: r.readAt,
    createdAt: r.createdAt,
  }));
}

/** Mark the caller's notifications read: the given ids, or all of them. */
export async function markNotificationsRead(
  db: Db,
  actor: Actor,
  ids: unknown,
): Promise<{ updated: number }> {
  assertCan(actor.role, 'workspace:read');
  const list = ids === 'all' ? null : parse(z.array(z.uuid()).max(200), ids);
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.workspaceId, actor.workspace.id),
        eq(notifications.userId, actor.userId),
        isNull(notifications.readAt),
        list
          ? inArray(notifications.id, list.length ? list : ['00000000-0000-0000-0000-000000000000'])
          : undefined,
      ),
    )
    .returning({ id: notifications.id });
  return { updated: rows.length };
}
