/**
 * Share links (Story 6.3).
 *
 * - Workspace-only by default; an Editor (share:manage) can make a link public (view-only),
 *   set an optional expiry, and revoke it.
 * - Tokens are 32 random bytes (base64url). Only their SHA-256 is stored; the token is shown
 *   once at creation.
 * - Resolving a token never reveals why it failed: unknown, revoked, expired, archived, or a
 *   workspace link opened by a non-member all look the same (NotFoundError).
 * - The resolved view contains only what's needed to render the design (frames + design system),
 *   read through a viewer-level actor scoped to the link's workspace.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { assertCan } from '@crunch/authz';
import {
  and,
  desc,
  eq,
  isNull,
  projects,
  shareLinks,
  sql,
  workspaces,
  type Db,
  type ShareLinkRow,
} from '@crunch/db';
import type { DesignDoc, DesignSystemSpec } from '@crunch/doc-model';
import { z } from 'zod';
import { recordActivity } from './activity';
import { getDoc } from './design-docs';
import { resolveProjectDesignSystem } from './project-design-system';
import { getProject } from './projects';
import { getSnapshotDoc } from './snapshots';
import { NotFoundError, ValidationError, type Actor } from './types';

export const SHARE_PATH_PREFIX = '/s/';
const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_EXPIRY_MS = 366 * 24 * 60 * 60 * 1000;

export function hashShareToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function newShareToken(): { token: string; tokenHash: string } {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashShareToken(token) };
}

export interface ShareLinkView {
  id: string;
  projectId: string;
  visibility: ShareLinkRow['visibility'];
  frameIds: string[] | null;
  docVersionId: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  viewCount: number;
  lastViewedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  /** Derived: not revoked and not expired. */
  active: boolean;
}

function view(r: ShareLinkRow, now = new Date()): ShareLinkView {
  return {
    id: r.id,
    projectId: r.projectId,
    visibility: r.visibility,
    frameIds: r.frameIds,
    docVersionId: r.docVersionId,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    viewCount: r.viewCount,
    lastViewedAt: r.lastViewedAt,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    active: !r.revokedAt && (!r.expiresAt || r.expiresAt > now),
  };
}

const expiry = z
  .union([z.iso.datetime({ offset: true }), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v === null) return v;
    const d = new Date(v);
    const ms = d.getTime() - Date.now();
    if (ms <= 0) {
      ctx.addIssue({ code: 'custom', message: 'Expiry must be in the future' });
      return z.NEVER;
    }
    if (ms > MAX_EXPIRY_MS) {
      ctx.addIssue({ code: 'custom', message: 'Expiry can be at most a year away' });
      return z.NEVER;
    }
    return d;
  });

const createInput = z
  .object({
    projectId: z.string(),
    visibility: z.enum(['workspace', 'public']).default('workspace'),
    expiresAt: expiry,
    frameIds: z.array(z.string().max(64)).min(1).max(200).nullable().optional(),
    docVersionId: z.uuid().nullable().optional(),
  })
  .strict();

const updateInput = z
  .object({ visibility: z.enum(['workspace', 'public']).optional(), expiresAt: expiry })
  .strict();

function parse<T>(schema: z.ZodType<T, unknown>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const i of r.error.issues) (fieldErrors[i.path.join('.') || '_'] ??= []).push(i.message);
    throw new ValidationError(r.error.issues[0]?.message ?? 'Invalid input', fieldErrors);
  }
  return r.data;
}

async function getLinkRow(db: Db, actor: Actor, linkId: string): Promise<ShareLinkRow> {
  if (!z.uuid().safeParse(linkId).success) throw new NotFoundError('Share link not found');
  const [row] = await db
    .select()
    .from(shareLinks)
    .where(and(eq(shareLinks.id, linkId), eq(shareLinks.workspaceId, actor.workspace.id)))
    .limit(1);
  if (!row) throw new NotFoundError('Share link not found');
  return row;
}

export async function createShareLink(
  db: Db,
  actor: Actor,
  input: unknown,
): Promise<{ link: ShareLinkView; token: string; path: string }> {
  assertCan(actor.role, 'share:manage');
  const data = parse(createInput, input);
  const project = await getProject(db, actor, data.projectId);

  let doc: DesignDoc;
  if (data.docVersionId) {
    doc = (await getSnapshotDoc(db, actor, project.id, data.docVersionId)).doc;
  } else {
    doc = (await getDoc(db, actor, project.id)).doc;
  }
  let frameIds: string[] | null = null;
  if (data.frameIds) {
    const known = new Set(doc.frames.map((f) => f.id));
    frameIds = [...new Set(data.frameIds)];
    if (frameIds.some((id) => !known.has(id)))
      throw new ValidationError('Unknown frame', { frameIds: ['Unknown frame'] });
  }

  const { token, tokenHash } = newShareToken();
  const [row] = await db
    .insert(shareLinks)
    .values({
      workspaceId: actor.workspace.id,
      projectId: project.id,
      tokenHash,
      visibility: data.visibility,
      frameIds,
      docVersionId: data.docVersionId ?? null,
      expiresAt: data.expiresAt ?? null,
      createdBy: actor.userId,
    })
    .returning();
  await recordActivity(db, actor, {
    projectId: project.id,
    verb: 'share.created',
    targetType: 'share_link',
    targetId: row!.id,
    data: { visibility: data.visibility, expiresAt: data.expiresAt?.toISOString() ?? null },
  });
  return { link: view(row!), token, path: `${SHARE_PATH_PREFIX}${token}` };
}

export async function listShareLinks(
  db: Db,
  actor: Actor,
  projectId: string,
): Promise<ShareLinkView[]> {
  assertCan(actor.role, 'share:manage');
  const project = await getProject(db, actor, projectId);
  const rows = await db
    .select()
    .from(shareLinks)
    .where(
      and(eq(shareLinks.projectId, project.id), eq(shareLinks.workspaceId, actor.workspace.id)),
    )
    .orderBy(desc(shareLinks.createdAt))
    .limit(200);
  const now = new Date();
  return rows.map((r) => view(r, now));
}

export async function updateShareLink(
  db: Db,
  actor: Actor,
  linkId: string,
  input: unknown,
): Promise<ShareLinkView> {
  assertCan(actor.role, 'share:manage');
  const data = parse(updateInput, input);
  const row = await getLinkRow(db, actor, linkId);
  if (row.revokedAt) throw new ValidationError('This link was revoked');
  const patch: Partial<Pick<ShareLinkRow, 'visibility' | 'expiresAt'>> = {};
  if (data.visibility) patch.visibility = data.visibility;
  if (data.expiresAt !== undefined) patch.expiresAt = data.expiresAt;
  if (!Object.keys(patch).length) return view(row);
  const [updated] = await db
    .update(shareLinks)
    .set(patch)
    .where(eq(shareLinks.id, row.id))
    .returning();
  await recordActivity(db, actor, {
    projectId: row.projectId,
    verb: 'share.updated',
    targetType: 'share_link',
    targetId: row.id,
    data: {
      visibility: updated!.visibility,
      expiresAt: updated!.expiresAt?.toISOString() ?? null,
    },
  });
  return view(updated!);
}

export async function revokeShareLink(
  db: Db,
  actor: Actor,
  linkId: string,
): Promise<ShareLinkView> {
  assertCan(actor.role, 'share:manage');
  const row = await getLinkRow(db, actor, linkId);
  if (row.revokedAt) return view(row);
  const [updated] = await db
    .update(shareLinks)
    .set({ revokedAt: new Date() })
    .where(eq(shareLinks.id, row.id))
    .returning();
  await recordActivity(db, actor, {
    projectId: row.projectId,
    verb: 'share.revoked',
    targetType: 'share_link',
    targetId: row.id,
  });
  return view(updated!);
}

// ---------------------------------------------------------------------------------------------
// Public resolution
// ---------------------------------------------------------------------------------------------

export interface SharedDesign {
  /** Only render inputs: no workspace, project or member data. */
  doc: DesignDoc;
  designSystem: DesignSystemSpec;
  frameIds: string[];
  visibility: ShareLinkRow['visibility'];
}

const notFound = () => new NotFoundError('Link not found');

/**
 * Resolve a share token for `viewer` (the signed-in actor, or null). Throws NotFoundError for
 * every failure so callers can't distinguish revoked/expired/foreign links from unknown ones.
 */
export async function resolveShareToken(
  db: Db,
  token: string,
  viewer: Actor | null,
  now = new Date(),
): Promise<SharedDesign> {
  if (!TOKEN_RE.test(token)) throw notFound();
  const tokenHash = hashShareToken(token);
  const [row] = await db
    .select({ link: shareLinks, project: projects, workspace: workspaces })
    .from(shareLinks)
    .innerJoin(projects, eq(projects.id, shareLinks.projectId))
    .innerJoin(workspaces, eq(workspaces.id, shareLinks.workspaceId))
    .where(
      and(
        eq(shareLinks.tokenHash, tokenHash),
        isNull(shareLinks.revokedAt),
        isNull(projects.archivedAt),
        isNull(workspaces.deletedAt),
        eq(projects.workspaceId, shareLinks.workspaceId),
      ),
    )
    .limit(1);
  // Defense in depth: compare hashes in constant time even though the index lookup matched.
  if (
    !row ||
    !timingSafeEqual(Buffer.from(row.link.tokenHash, 'hex'), Buffer.from(tokenHash, 'hex'))
  )
    throw notFound();
  const { link, project, workspace } = row;
  if (link.expiresAt && link.expiresAt <= now) throw notFound();
  if (link.visibility !== 'public' && (!viewer || viewer.workspace.id !== link.workspaceId))
    throw notFound();

  // Read the design as a viewer of the link's workspace (project:read only, workspace-scoped).
  const reader: Actor = { userId: `share:${link.id}`, role: 'viewer', workspace };
  let doc: DesignDoc;
  try {
    doc = link.docVersionId
      ? (await getSnapshotDoc(db, reader, project.id, link.docVersionId)).doc
      : (await getDoc(db, reader, project.id)).doc;
  } catch (e) {
    if (e instanceof NotFoundError) throw notFound();
    throw e;
  }
  const ds = await resolveProjectDesignSystem(db, reader, project);
  const known = new Set(doc.frames.map((f) => f.id));
  const frameIds = (link.frameIds ?? doc.frames.map((f) => f.id)).filter((id) => known.has(id));

  await db
    .update(shareLinks)
    .set({ viewCount: sql`${shareLinks.viewCount} + 1`, lastViewedAt: now })
    .where(eq(shareLinks.id, link.id));
  return { doc, designSystem: ds.spec, frameIds, visibility: link.visibility };
}

// ---------------------------------------------------------------------------------------------
// Rate limiting for the public viewer.
//
// v1 is in-memory, per server instance (a shared store is tracked under Story 9.3).
// Deployment assumption: the app runs on Vercel, which sets `x-real-ip` (and
// `x-vercel-forwarded-for`) from the TCP peer and overwrites client-sent values. Elsewhere, put
// it behind exactly one trusted proxy that sets `x-real-ip` or appends to `x-forwarded-for`.
// ---------------------------------------------------------------------------------------------

/**
 * Sliding-window limiter with segmented eviction: a key starts in a small "probation" map and
 * is promoted to the "protected" map on its second hit in the window. A flood of one-off random
 * keys only churns probation, so the counters of clients that actually repeat (the ones being
 * limited) are not evicted and reset.
 */
export class RateLimiter {
  private probation = new Map<string, number[]>();
  private protected = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Record a hit; returns whether it's allowed and when to retry if not. */
  check(key: string, now = Date.now()): { ok: boolean; retryAfterSec: number } {
    const since = now - this.windowMs;
    const inProtected = this.protected.has(key);
    const list = ((inProtected ? this.protected : this.probation).get(key) ?? []).filter(
      (t) => t > since,
    );
    if (list.length >= this.limit) {
      this.protected.delete(key);
      this.protected.set(key, list);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((list[0]! - since) / 1000)) };
    }
    list.push(now);
    this.probation.delete(key);
    this.protected.delete(key);
    if (list.length >= 2 || inProtected) this.protected.set(key, list);
    else this.probation.set(key, list); // re-insert: Map order ≈ LRU
    this.evict(since);
    return { ok: true, retryAfterSec: 0 };
  }

  /** Number of tracked keys (tests, metrics). */
  get size(): number {
    return this.probation.size + this.protected.size;
  }

  private evict(since: number) {
    while (this.probation.size > this.maxKeys) {
      const oldest = this.probation.keys().next().value;
      if (oldest === undefined) break;
      this.probation.delete(oldest);
    }
    if (this.protected.size <= this.maxKeys) return;
    // Drop keys whose window has fully expired before evicting any live counter.
    for (const [k, hits] of this.protected)
      if (!hits.some((t) => t > since)) this.protected.delete(k);
    while (this.protected.size > this.maxKeys) {
      const oldest = this.protected.keys().next().value;
      if (oldest === undefined) break;
      this.protected.delete(oldest);
    }
  }
}

const g = globalThis as unknown as { __crunchShareLimiter?: RateLimiter };
/** 60 views per minute per client (per instance). */
export const shareViewLimiter = (g.__crunchShareLimiter ??= new RateLimiter(60, 60_000));

const IP_RE = /^[0-9a-fA-F:.]{2,45}$/;
const validIp = (v: string | null | undefined) => {
  const t = v?.trim();
  return t && IP_RE.test(t) ? t : null;
};

/**
 * Client IP from platform-set headers, or null if unknown. Prefers `x-real-ip` and
 * `x-vercel-forwarded-for` (set by Vercel, not spoofable there). For `x-forwarded-for` it takes
 * the rightmost entry (added by the nearest trusted proxy), never the client-controlled leftmost.
 */
export function clientIp(headers: Headers): string | null {
  const real = validIp(headers.get('x-real-ip'));
  if (real) return real;
  const vercel = validIp(headers.get('x-vercel-forwarded-for')?.split(',')[0]);
  if (vercel) return vercel;
  const xff = headers.get('x-forwarded-for');
  if (xff) return validIp(xff.split(',').at(-1));
  return null;
}

/**
 * Limiter key for a share-view request: the client IP, or, when no IP is available, a bucket
 * per share token, so one anonymous client can't exhaust a shared bucket for everyone.
 */
export function shareRateKey(headers: Headers, token: string): string {
  const ip = clientIp(headers);
  return ip ? `ip:${ip}` : `token:${hashShareToken(token).slice(0, 32)}`;
}
