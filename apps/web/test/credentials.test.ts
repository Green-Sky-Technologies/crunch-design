import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError } from '@crunch/authz';
import { generateMasterKey, parseKeyring } from '@crunch/crypto';
import { eq, providerCredentials } from '@crunch/db';
import type { TestResult } from '@crunch/providers';
import {
  deleteCredential,
  getExternalId,
  getPublicCredential,
  hasWorkingCredential,
  saveCredential,
  testCredential,
} from '@/server/services/credentials';
import { ValidationError } from '@/server/services/types';
import { makeActor, reset, testDb } from './helpers';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

const keyring = parseKeyring(`t1:${generateMasterKey()}`);
const KEY = 'sk-ant-api03-' + 'S'.repeat(40) + 'LAST';

describe('provider credentials', () => {
  it('admins save an encrypted credential; secrets never come back', async () => {
    const admin = await makeActor(db, 'admin');
    const pub = await saveCredential(
      db,
      admin,
      { provider: 'anthropic', apiKey: KEY },
      { keyring },
    );
    expect(pub).toMatchObject({ provider: 'anthropic', hint: '…LAST', status: 'untested' });
    expect(JSON.stringify(pub)).not.toContain(KEY);

    const [row] = await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.workspaceId, admin.workspace.id));
    expect(row!.secretEnvelope).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(KEY); // stored only as ciphertext
  });

  it('test updates status and passes decrypted secrets only to the tester', async () => {
    const admin = await makeActor(db, 'admin');
    await saveCredential(db, admin, { provider: 'anthropic', apiKey: KEY }, { keyring });
    let seen = '';
    const ok = await testCredential(db, admin, {
      keyring,
      tester: async (_c, secret): Promise<TestResult> => {
        seen = secret?.provider === 'anthropic' ? secret.apiKey : '';
        return { ok: true, model: 'claude-haiku-5-5' };
      },
    });
    expect(seen).toBe(KEY);
    expect(ok.status).toBe('ok');
    expect(await hasWorkingCredential(db, admin.workspace.id)).toBe(true);

    const bad = await testCredential(db, admin, {
      keyring,
      tester: async () => ({ ok: false, error: 'HTTP 401 — rejected' }),
    });
    expect(bad).toMatchObject({ status: 'error', lastError: 'HTTP 401 — rejected' });
  });

  it('a ciphertext copied to another workspace cannot be decrypted', async () => {
    const a = await makeActor(db, 'admin');
    const b = await makeActor(db, 'admin');
    await saveCredential(db, a, { provider: 'anthropic', apiKey: KEY }, { keyring });
    await saveCredential(
      db,
      b,
      { provider: 'foundry', resource: 'r', apiKey: 'f'.repeat(32) },
      { keyring },
    );
    const [rowA] = await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.workspaceId, a.workspace.id));
    await db
      .update(providerCredentials)
      .set({ provider: 'anthropic', config: rowA!.config, secretEnvelope: rowA!.secretEnvelope })
      .where(eq(providerCredentials.workspaceId, b.workspace.id));
    await expect(
      testCredential(db, b, { keyring, tester: async () => ({ ok: true, model: 'm' }) }),
    ).rejects.toThrow(/Decryption failed/);
  });

  it('only admins can manage credentials; editors and viewers can see the public view', async () => {
    const admin = await makeActor(db, 'admin');
    const editor = await makeActor(db, 'editor', admin.workspace);
    const viewer = await makeActor(db, 'viewer', admin.workspace);
    await expect(
      saveCredential(db, editor, { provider: 'anthropic', apiKey: KEY }, { keyring }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await saveCredential(db, admin, { provider: 'anthropic', apiKey: KEY }, { keyring });
    await expect(testCredential(db, viewer, { keyring })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteCredential(db, editor)).rejects.toBeInstanceOf(ForbiddenError);
    const pub = await getPublicCredential(db, viewer);
    expect(JSON.stringify(pub)).not.toContain(KEY);
  });

  it('bedrock assume-role uses a stable server-generated external id', async () => {
    const admin = await makeActor(db, 'admin');
    const ext = await getExternalId(db, admin.workspace.id);
    expect(ext).toMatch(/^crunch-[0-9a-f]{32}$/);
    const pub = await saveCredential(
      db,
      admin,
      {
        provider: 'bedrock',
        authMode: 'assume_role',
        region: 'us-east-1',
        roleArn: 'arn:aws:iam::123456789012:role/Crunch',
      },
      { keyring },
    );
    expect(pub.details['External ID']).toBe(ext);
    // Replacing the credential keeps the same external id (customer trust policy depends on it)
    await deleteCredential(db, admin);
    expect(await getExternalId(db, admin.workspace.id)).toBe(ext);
  });

  it('returns field errors for invalid input', async () => {
    const admin = await makeActor(db, 'admin');
    await expect(
      saveCredential(db, admin, { provider: 'anthropic', apiKey: 'x' }, { keyring }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
