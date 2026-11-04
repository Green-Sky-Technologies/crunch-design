import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, pluginTokens, workspaces } from '@crunch/db';
import {
  authenticatePluginToken,
  bearerFrom,
  createPluginToken,
  hashPluginToken,
  InvalidTokenError,
  listPluginTokens,
  MAX_TOKENS_PER_USER,
  revokePluginToken,
} from '@/server/services/plugin-tokens';
import { removeMember, upsertMember } from '@/server/services/workspaces';
import { NotFoundError, ValidationError } from '@/server/services/types';
import { makeActor, reset, testDb } from './helpers';
import type { Actor } from '@/server/services/types';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

async function member(role: Actor['role'], ws?: Actor['workspace']) {
  const a = await makeActor(db, role, ws);
  await upsertMember(db, a.workspace.id, a.userId, role);
  return a;
}

describe('plugin tokens', () => {
  it('shows the token once and stores only its sha-256 hash and last 4 chars', async () => {
    const editor = await member('editor');
    const { token, record } = await createPluginToken(db, editor, { name: 'Laptop' });
    expect(token).toMatch(/^cdp_[A-Za-z0-9_-]{43}$/);
    expect(record.hint).toBe(`cdp_…${token.slice(-4)}`);
    expect(JSON.stringify(record)).not.toContain(token);

    const [row] = await db.select().from(pluginTokens).where(eq(pluginTokens.id, record.id));
    expect(row!.tokenHash).toBe(hashPluginToken(token));
    expect(JSON.stringify(row)).not.toContain(token.slice(4, 40));
    const listed = await listPluginTokens(db, editor);
    expect(JSON.stringify(listed)).not.toContain(token);
  });

  it('validates the name and caps live tokens per user', async () => {
    const editor = await member('editor');
    await expect(createPluginToken(db, editor, { name: '  ' })).rejects.toThrow(ValidationError);
    for (let i = 0; i < MAX_TOKENS_PER_USER; i++)
      await createPluginToken(db, editor, { name: `t${i}` });
    await expect(createPluginToken(db, editor, { name: 'one more' })).rejects.toThrow(
      ValidationError,
    );
  });

  it('authenticates to the owner, workspace and current role; updates last_used_at', async () => {
    const editor = await member('editor');
    const { token, record } = await createPluginToken(db, editor, { name: 'x' });
    const actor = await authenticatePluginToken(db, token);
    expect(actor).toMatchObject({
      userId: editor.userId,
      role: 'editor',
      tokenId: record.id,
      workspace: { id: editor.workspace.id },
    });
    const [row] = await db.select().from(pluginTokens).where(eq(pluginTokens.id, record.id));
    expect(row!.lastUsedAt).toBeInstanceOf(Date);

    // Role changes apply immediately (role comes from members, not from the token).
    await upsertMember(db, editor.workspace.id, editor.userId, 'viewer');
    expect((await authenticatePluginToken(db, token)).role).toBe('viewer');
  });

  it('rejects malformed, unknown, revoked, removed-member and deleted-workspace tokens', async () => {
    const editor = await member('editor');
    await expect(authenticatePluginToken(db, null)).rejects.toThrow(InvalidTokenError);
    await expect(authenticatePluginToken(db, 'nope')).rejects.toThrow(InvalidTokenError);
    await expect(authenticatePluginToken(db, `cdp_${'a'.repeat(43)}`)).rejects.toThrow(
      InvalidTokenError,
    );

    const a = await createPluginToken(db, editor, { name: 'a' });
    await revokePluginToken(db, editor, a.record.id);
    await expect(authenticatePluginToken(db, a.token)).rejects.toThrow(InvalidTokenError);
    expect(await listPluginTokens(db, editor)).toHaveLength(0);

    const b = await createPluginToken(db, editor, { name: 'b' });
    await removeMember(db, editor.workspace.id, editor.userId);
    await expect(authenticatePluginToken(db, b.token)).rejects.toThrow(InvalidTokenError);

    const other = await member('admin');
    const c = await createPluginToken(db, other, { name: 'c' });
    await db
      .update(workspaces)
      .set({ deletedAt: new Date() })
      .where(eq(workspaces.id, other.workspace.id));
    await expect(authenticatePluginToken(db, c.token)).rejects.toThrow(InvalidTokenError);
  });

  it('members see and revoke only their own tokens; admins manage all in their workspace', async () => {
    const admin = await member('admin');
    const editor = await member('editor', admin.workspace);
    const viewer = await member('viewer', admin.workspace);
    const e = await createPluginToken(db, editor, { name: 'editor' });
    const v = await createPluginToken(db, viewer, { name: 'viewer' });

    expect((await listPluginTokens(db, editor)).map((t) => t.name)).toEqual(['editor']);
    expect((await listPluginTokens(db, admin)).map((t) => t.name).sort()).toEqual([
      'editor',
      'viewer',
    ]);
    await expect(revokePluginToken(db, editor, v.record.id)).rejects.toThrow(NotFoundError);
    await revokePluginToken(db, admin, e.record.id);
    await expect(authenticatePluginToken(db, e.token)).rejects.toThrow(InvalidTokenError);

    // Another workspace's admin can't see or revoke it.
    const outsider = await member('admin');
    await expect(revokePluginToken(db, outsider, v.record.id)).rejects.toThrow(NotFoundError);
    expect(await listPluginTokens(db, outsider)).toHaveLength(0);
    await expect(revokePluginToken(db, admin, 'not-a-uuid')).rejects.toThrow(NotFoundError);
  });

  it('parses bearer headers strictly', () => {
    expect(bearerFrom('Bearer cdp_abc')).toBe('cdp_abc');
    expect(bearerFrom('bearer   cdp_abc ')).toBe('cdp_abc');
    expect(bearerFrom('Basic xyz')).toBeNull();
    expect(bearerFrom('Bearer a b')).toBeNull();
    expect(bearerFrom(null)).toBeNull();
  });
});
