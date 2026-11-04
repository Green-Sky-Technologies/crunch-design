/**
 * Project activity (Story 6.4). Collab/export services write rows here; the feed merges them
 * with the doc_ops log so design edits (human vs. agent) appear without extra writes.
 */
import { assertCan } from '@crunch/authz';
import { activity, and, desc, docOps, eq, inArray, sql, users, type Db } from '@crunch/db';
import { z } from 'zod';
import { getProject } from './projects';
import { ValidationError, type Actor } from './types';

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
  /** 'op:<newestOpId>' for grouped design edits, 'act:<id>' for activity rows. */
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

/**
 * Keyset position in one stream: [created_at as epoch microseconds, row id]. Microseconds keep
 * Postgres' full precision (a JS Date truncates to ms, which would skip or repeat rows).
 */
export type StreamPos = [us: string, id: number];

/** Pagination cursor: independent positions in the doc_ops and activity streams. */
export interface FeedCursor {
  op: StreamPos | null;
  act: StreamPos | null;
}

export interface FeedOptions {
  limit?: number;
  /** Continue after this cursor (a previous page's `nextCursor`). */
  cursor?: string;
  /** 'human' = user + system, 'agent' = agent only. */
  who?: 'all' | 'human' | 'agent';
  /** doc_ops rows fetched per page = limit × this (grouping needs more rows than entries). */
  opFetchFactor?: number;
}

export function encodeFeedCursor(c: FeedCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

const streamPos = z.tuple([z.string().regex(/^\d{1,20}$/), z.number().int().nonnegative()]);
const cursorSchema = z.object({ op: streamPos.nullable(), act: streamPos.nullable() }).strict();

export function decodeFeedCursor(raw: string): FeedCursor {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw new ValidationError('Invalid cursor');
  }
}

/** Consecutive edits by the same actor (same kind) within this window collapse into one entry. */
export const EDIT_GROUP_WINDOW_MS = 5 * 60 * 1000;

export interface OpRow {
  id: number;
  version: number;
  actorType: ActorKind;
  actorId: string;
  source: string;
  label: string | null;
  createdAt: Date;
  /** created_at in epoch microseconds (exact). */
  us: string;
}

export interface EditGroup {
  entry: FeedEntry;
  /** Newest op in the group (the entry's sort position). */
  head: StreamPos;
  /** Oldest op in the group: the next page continues strictly after it. */
  tail: StreamPos;
}

/** Group newest-first op rows into feed entries. Pure (exported for tests). */
export function groupEdits(rows: OpRow[]): EditGroup[] {
  const out: EditGroup[] = [];
  let cur: EditGroup | null = null;
  let lastAt = 0;
  for (const r of rows) {
    const t = r.createdAt.getTime();
    if (
      cur &&
      cur.entry.actorId === r.actorId &&
      cur.entry.actorType === r.actorType &&
      lastAt - t <= EDIT_GROUP_WINDOW_MS
    ) {
      const e = cur.entry.edits!;
      e.count++;
      e.fromVersion = Math.min(e.fromVersion, r.version);
      if (!e.sources.includes(r.source)) e.sources.push(r.source);
      if (r.label && !e.labels.includes(r.label) && e.labels.length < 5) e.labels.push(r.label);
      cur.tail = [r.us, r.id];
      lastAt = t;
      continue;
    }
    cur = {
      entry: {
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
      },
      head: [r.us, r.id],
      tail: [r.us, r.id],
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

/** Exact epoch-microsecond text for a timestamptz column. */
const usOf = (col: typeof docOps.createdAt | typeof activity.createdAt) =>
  sql<string>`(extract(epoch from ${col}) * 1000000)::bigint::text`;

/** (created_at, id) strictly before `pos`, compared at microsecond precision. */
const olderThan = (
  createdAt: typeof docOps.createdAt | typeof activity.createdAt,
  id: typeof docOps.id | typeof activity.id,
  pos: StreamPos | null,
) =>
  pos
    ? sql`(${createdAt}, ${id}) < (timestamptz 'epoch' + (${pos[0]})::bigint * interval '1 microsecond', ${pos[1]})`
    : undefined;

interface Candidate {
  entry: FeedEntry;
  us: bigint;
  id: number;
  stream: 'op' | 'act';
  /** Where this stream resumes once this entry has been emitted. */
  resume: StreamPos;
}

const newestFirst = (a: Candidate, b: Candidate) =>
  a.us !== b.us
    ? a.us > b.us
      ? -1
      : 1
    : a.stream !== b.stream
      ? a.stream === 'act'
        ? -1
        : 1
      : b.id - a.id;

/**
 * Project feed: design edits from doc_ops (grouped) merged with activity rows, newest first.
 * Pagination uses a compound keyset cursor per stream (created_at µs + id). A grouped edit
 * resumes after its oldest op, so an edit burst on a page boundary is never repeated, and an
 * entry is only emitted once every older-or-equal row of both streams has been fetched.
 */
export async function listActivity(
  db: Db,
  actor: Actor,
  projectId: string,
  opts: FeedOptions = {},
): Promise<{ entries: FeedEntry[]; nextCursor: string | null }> {
  assertCan(actor.role, 'project:read');
  const project = await getProject(db, actor, projectId);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const cursor: FeedCursor = opts.cursor ? decodeFeedCursor(opts.cursor) : { op: null, act: null };
  const opCap = limit * Math.max(opts.opFetchFactor ?? 10, 1);

  const opRows: OpRow[] = await db
    .select({
      id: docOps.id,
      version: docOps.version,
      actorType: docOps.actorType,
      actorId: docOps.actorId,
      source: docOps.source,
      label: docOps.label,
      createdAt: docOps.createdAt,
      us: usOf(docOps.createdAt),
    })
    .from(docOps)
    .where(
      and(
        eq(docOps.projectId, project.id),
        eq(docOps.workspaceId, actor.workspace.id),
        olderThan(docOps.createdAt, docOps.id, cursor.op),
        whoFilter(docOps.actorType, opts.who),
      ),
    )
    .orderBy(desc(docOps.createdAt), desc(docOps.id))
    .limit(opCap);
  const actRows = await db
    .select({ row: activity, us: usOf(activity.createdAt) })
    .from(activity)
    .where(
      and(
        eq(activity.projectId, project.id),
        eq(activity.workspaceId, actor.workspace.id),
        olderThan(activity.createdAt, activity.id, cursor.act),
        whoFilter(activity.actorType, opts.who),
      ),
    )
    .orderBy(desc(activity.createdAt), desc(activity.id))
    .limit(limit);

  const opsCapped = opRows.length === opCap;
  const actsCapped = actRows.length === limit;

  let groups = groupEdits(opRows);
  // Rows not fetched yet are older than the window. Whatever sorts at or below the boundary
  // might have unfetched rows above it, so it waits for the next page.
  const candidateOk: ((c: Candidate) => boolean)[] = [];
  if (opsCapped) {
    if (groups.length > 1) {
      // The last group may continue past the window: hold it (and anything older) back.
      const held = groups.at(-1)!;
      groups = groups.slice(0, -1);
      const holdUs = BigInt(held.head[0]);
      candidateOk.push((c) => c.us > holdUs);
    } else {
      // One huge burst: emit what we have; it continues as a new entry on the next page.
      const tailUs = BigInt(groups[0]!.tail[0]);
      candidateOk.push((c) => c.us >= tailUs);
    }
  }
  if (actsCapped) {
    const oldestAct = BigInt(actRows.at(-1)!.us);
    candidateOk.push((c) => c.us >= oldestAct);
  }

  const candidates = [
    ...groups.map<Candidate>((g) => ({
      entry: g.entry,
      us: BigInt(g.head[0]),
      id: g.head[1],
      stream: 'op',
      resume: g.tail,
    })),
    ...actRows.map<Candidate>(({ row: r, us }) => ({
      entry: {
        id: `act:${r.id}`,
        at: r.createdAt,
        actorType: r.actorType,
        actorId: r.actorId,
        actorName: null,
        verb: r.verb,
        targetType: r.targetType,
        targetId: r.targetId,
        data: (r.data ?? {}) as Record<string, unknown>,
      },
      us: BigInt(us),
      id: r.id,
      stream: 'act',
      resume: [us, r.id],
    })),
  ]
    .filter((c) => candidateOk.every((ok) => ok(c)))
    .sort(newestFirst);
  const page = candidates.slice(0, limit);

  const next: FeedCursor = { ...cursor };
  for (const c of page) next[c.stream] = c.resume;
  const more = opsCapped || actsCapped || candidates.length > page.length;

  const entries = page.map((c) => c.entry);
  const ids = [...new Set(entries.map((e) => e.actorId))];
  if (ids.length) {
    const names = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, ids));
    const byId = new Map(names.map((n) => [n.id, n.name ?? n.email ?? null]));
    for (const e of entries) e.actorName = byId.get(e.actorId) ?? null;
  }
  return { entries, nextCursor: more && page.length ? encodeFeedCursor(next) : null };
}
