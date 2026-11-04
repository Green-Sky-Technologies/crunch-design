/**
 * Project activity (Story 6.4). Collab/export services write rows here; the feed merges them
 * with the doc_ops log so design edits (human vs. agent) appear without extra writes.
 */
import { assertCan } from '@crunch/authz';
import { activity, and, desc, docOps, eq, inArray, lt, users, type Db } from '@crunch/db';
import { getProject } from './projects';
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

// ---------------------------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------------------------

export type ActorKind = 'user' | 'agent' | 'system';

export interface FeedEntry {
  /** 'op:<firstOpId>' for grouped design edits, 'act:<id>' for activity rows. */
  id: string;
  at: Date;
  actorType: ActorKind;
  actorId: string;
  actorName: string | null;
  /** 'doc.edited' for design edits; otherwise the activity verb. */
  verb: 'doc.edited' | ActivityVerb | (string & {});
  targetType: string | null;
  targetId: string | null;
  data: Record<string, unknown>;
  /** For doc.edited: number of transactions grouped, their sources and labels, version range. */
  edits?: {
    count: number;
    sources: string[];
    labels: string[];
    fromVersion: number;
    toVersion: number;
  };
}

export interface FeedOptions {
  limit?: number;
  /** Only entries strictly older than this (pagination cursor = last entry's `at`). */
  before?: Date;
  /** 'human' = user + system, 'agent' = agent only. */
  who?: 'all' | 'human' | 'agent';
}

/** Consecutive edits by the same actor (same kind) within this window collapse into one entry. */
export const EDIT_GROUP_WINDOW_MS = 5 * 60 * 1000;

interface OpRow {
  id: number;
  version: number;
  actorType: ActorKind;
  actorId: string;
  source: string;
  label: string | null;
  createdAt: Date;
}

/** Group newest-first op rows into feed entries. Pure (exported for tests). */
export function groupEdits(rows: OpRow[]): FeedEntry[] {
  const out: FeedEntry[] = [];
  let cur: FeedEntry | null = null;
  let lastAt = 0;
  for (const r of rows) {
    const t = r.createdAt.getTime();
    if (
      cur &&
      cur.actorId === r.actorId &&
      cur.actorType === r.actorType &&
      lastAt - t <= EDIT_GROUP_WINDOW_MS
    ) {
      const e = cur.edits!;
      e.count++;
      e.fromVersion = Math.min(e.fromVersion, r.version);
      if (!e.sources.includes(r.source)) e.sources.push(r.source);
      if (r.label && !e.labels.includes(r.label) && e.labels.length < 5) e.labels.push(r.label);
      lastAt = t;
      continue;
    }
    cur = {
      id: `op:${r.id}`,
      at: r.createdAt,
      actorType: r.actorType,
      actorId: r.actorId,
      actorName: null,
      verb: 'doc.edited',
      targetType: 'design_doc',
      targetId: null,
      data: {},
      edits: {
        count: 1,
        sources: [r.source],
        labels: r.label ? [r.label] : [],
        fromVersion: r.version,
        toVersion: r.version,
      },
    };
    lastAt = t;
    out.push(cur);
  }
  return out;
}

const whoFilter = (col: typeof docOps.actorType | typeof activity.actorType, who?: string) =>
  who === 'agent'
    ? eq(col, 'agent')
    : who === 'human'
      ? inArray(col, ['user', 'system'])
      : undefined;

export async function listActivity(
  db: Db,
  actor: Actor,
  projectId: string,
  opts: FeedOptions = {},
): Promise<{ entries: FeedEntry[]; nextBefore: string | null }> {
  assertCan(actor.role, 'project:read');
  const project = await getProject(db, actor, projectId);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  // Fetch extra op rows so grouping still yields up to `limit` entries.
  const opRows = await db
    .select({
      id: docOps.id,
      version: docOps.version,
      actorType: docOps.actorType,
      actorId: docOps.actorId,
      source: docOps.source,
      label: docOps.label,
      createdAt: docOps.createdAt,
    })
    .from(docOps)
    .where(
      and(
        eq(docOps.projectId, project.id),
        eq(docOps.workspaceId, actor.workspace.id),
        opts.before ? lt(docOps.createdAt, opts.before) : undefined,
        whoFilter(docOps.actorType, opts.who),
      ),
    )
    .orderBy(desc(docOps.createdAt), desc(docOps.id))
    .limit(limit * 10);
  const actRows = await db
    .select()
    .from(activity)
    .where(
      and(
        eq(activity.projectId, project.id),
        eq(activity.workspaceId, actor.workspace.id),
        opts.before ? lt(activity.createdAt, opts.before) : undefined,
        whoFilter(activity.actorType, opts.who),
      ),
    )
    .orderBy(desc(activity.createdAt), desc(activity.id))
    .limit(limit);

  const merged = [
    ...groupEdits(opRows),
    ...actRows.map<FeedEntry>((r) => ({
      id: `act:${r.id}`,
      at: r.createdAt,
      actorType: r.actorType,
      actorId: r.actorId,
      actorName: null,
      verb: r.verb,
      targetType: r.targetType,
      targetId: r.targetId,
      data: (r.data ?? {}) as Record<string, unknown>,
    })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());
  // If op rows hit their cap, entries older than the oldest fetched op are incomplete: stop there.
  const opCutoff = opRows.length === limit * 10 ? opRows[opRows.length - 1]!.createdAt : null;
  const complete = opCutoff ? merged.filter((e) => e.at >= opCutoff) : merged;
  const entries = complete.slice(0, limit);

  const ids = [...new Set(entries.map((e) => e.actorId))];
  if (ids.length) {
    const names = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, ids));
    const byId = new Map(names.map((n) => [n.id, n.name ?? n.email ?? null]));
    for (const e of entries) e.actorName = byId.get(e.actorId) ?? null;
  }
  const more = entries.length === limit || complete.length < merged.length;
  return {
    entries,
    nextBefore: more && entries.length ? entries[entries.length - 1]!.at.toISOString() : null,
  };
}
