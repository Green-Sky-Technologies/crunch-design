import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import {
  credentialInput,
  redact,
  secretValues,
  splitCredential,
  toPublicCredential,
  providerModelId,
  testConnection,
  type ClaudeClient,
} from './index';

const SA = JSON.stringify({
  type: 'service_account',
  client_email: 'crunch@proj.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIEsecretsecret\n-----END PRIVATE KEY-----\n',
  private_key_id: 'abcdef1234567890',
});

describe('credential input validation', () => {
  it('accepts each provider', () => {
    expect(
      credentialInput.safeParse({ provider: 'anthropic', apiKey: 'sk-ant-api03-' + 'x'.repeat(40) })
        .success,
    ).toBe(true);
    expect(
      credentialInput.safeParse({
        provider: 'bedrock',
        authMode: 'assume_role',
        region: 'us-east-1',
        roleArn: 'arn:aws:iam::123456789012:role/CrunchDesignBedrock',
      }).success,
    ).toBe(true);
    expect(
      credentialInput.safeParse({
        provider: 'vertex',
        projectId: 'p',
        region: 'global',
        serviceAccountJson: SA,
      }).success,
    ).toBe(true);
    expect(
      credentialInput.safeParse({ provider: 'foundry', resource: 'my-res', apiKey: 'f'.repeat(32) })
        .success,
    ).toBe(true);
  });

  it('rejects bad input', () => {
    expect(credentialInput.safeParse({ provider: 'anthropic', apiKey: 'short' }).success).toBe(
      false,
    );
    expect(
      credentialInput.safeParse({
        provider: 'bedrock',
        authMode: 'assume_role',
        region: 'us-east-1',
        roleArn: 'nope',
      }).success,
    ).toBe(false);
    expect(
      credentialInput.safeParse({
        provider: 'vertex',
        projectId: 'p',
        region: 'global',
        serviceAccountJson: '{}',
      }).success,
    ).toBe(false);
  });
});

describe('secret handling', () => {
  const key = 'sk-ant-api03-' + 'k'.repeat(40) + 'WXYZ';

  it('splits secrets away from config and exposes only a hint', () => {
    const split = splitCredential({ provider: 'anthropic', apiKey: key }, 'ext');
    expect(JSON.stringify(split.config)).not.toContain(key);
    expect(split.hint).toBe('…WXYZ');
    const pub = toPublicCredential({
      provider: 'anthropic',
      config: split.config,
      hint: split.hint,
      status: 'ok',
      lastTestedAt: null,
      lastError: null,
      updatedAt: new Date(),
    });
    expect(JSON.stringify(pub)).not.toContain(key);
  });

  it('keeps the vertex private key out of config and the public view', () => {
    const split = splitCredential(
      { provider: 'vertex', projectId: 'p', region: 'global', serviceAccountJson: SA },
      'ext',
    );
    expect(JSON.stringify(split.config)).not.toContain('PRIVATE KEY');
    const pub = toPublicCredential({
      provider: 'vertex',
      config: split.config,
      hint: split.hint,
      status: 'untested',
      lastTestedAt: null,
      lastError: null,
      updatedAt: new Date(),
    });
    expect(JSON.stringify(pub)).not.toContain('PRIVATE KEY');
    expect(pub.details['Service account']).toBe('crunch@proj.iam.gserviceaccount.com');
  });

  it('assume-role credentials have no secret and include the external id', () => {
    const split = splitCredential(
      {
        provider: 'bedrock',
        authMode: 'assume_role',
        region: 'us-west-2',
        roleArn: 'arn:aws:iam::123456789012:role/R',
      },
      'ext-123',
    );
    expect(split.secret).toBeNull();
    expect(split.config).toMatchObject({ externalId: 'ext-123' });
  });

  it('redacts secrets from error text', () => {
    const secret = splitCredential(
      { provider: 'vertex', projectId: 'p', region: 'global', serviceAccountJson: SA },
      'e',
    ).secret;
    const msg = `failed with ${key} and ${JSON.parse(SA).private_key}`;
    const out = redact(msg, secretValues(secret));
    expect(out).not.toContain(key);
    expect(out).not.toContain('MIIEsecret');
  });
});

describe('testConnection', () => {
  const key = 'sk-ant-api03-' + 'z'.repeat(40);
  const fakeClient = (impl: () => Promise<unknown>) =>
    ({ messages: { countTokens: impl } }) as unknown as ClaudeClient;

  it('reports success with the provider-specific model id', async () => {
    const res = await testConnection(
      { provider: 'bedrock', region: 'us-east-1', authMode: 'access_keys', accessKeyId: 'AKIA' },
      null,
      {
        client: fakeClient(async () => ({ input_tokens: 1 })),
      },
    );
    expect(res).toEqual({ ok: true, model: 'anthropic.claude-haiku-5-5' });
  });

  it('returns a redacted, friendly error', async () => {
    const res = await testConnection(
      { provider: 'anthropic' },
      { provider: 'anthropic', apiKey: key },
      {
        client: fakeClient(async () => {
          throw new Anthropic.AuthenticationError(
            401,
            { error: { message: `bad key ${key}` } },
            `bad key ${key}`,
            new Headers(),
          );
        }),
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('HTTP 401');
      expect(res.error).not.toContain(key);
    }
  });

  it('maps model ids per provider', () => {
    expect(providerModelId('vertex', 'claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(providerModelId('bedrock', 'claude-opus-5-5')).toBe('anthropic.claude-opus-5-5');
  });
});
