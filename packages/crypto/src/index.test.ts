import { describe, expect, it } from 'vitest';
import {
  CryptoError,
  decryptSecret,
  encryptSecret,
  envelopeKeyId,
  generateMasterKey,
  parseKeyring,
  reencryptSecret,
} from './index';

const k1 = generateMasterKey();
const k2 = generateMasterKey();

describe('envelope encryption', () => {
  const ring = parseKeyring(`k1:${k1}`);

  it('round-trips', () => {
    const env = encryptSecret('sk-ant-secret', 'ws_1', ring);
    expect(decryptSecret(env, 'ws_1', ring)).toBe('sk-ant-secret');
  });

  it('never contains the plaintext and is randomized', () => {
    const a = encryptSecret('sk-ant-secret', 'ws_1', ring);
    const b = encryptSecret('sk-ant-secret', 'ws_1', ring);
    expect(a).not.toContain('sk-ant-secret');
    expect(a).not.toBe(b);
  });

  it('rejects a ciphertext moved to another workspace (AAD binding)', () => {
    const env = encryptSecret('x', 'ws_1', ring);
    expect(() => decryptSecret(env, 'ws_2', ring)).toThrow(CryptoError);
  });

  it('detects tampering', () => {
    const env = encryptSecret('hello', 'ws_1', ring);
    const parts = env.split(':');
    const ct = Buffer.from(parts[5]!, 'base64url');
    ct[0] = ct[0]! ^ 0xff;
    parts[5] = ct.toString('base64url');
    expect(() => decryptSecret(parts.join(':'), 'ws_1', ring)).toThrow(CryptoError);
  });

  it('supports key rotation', () => {
    const old = encryptSecret('rotate-me', 'ws_1', ring);
    const rotated = parseKeyring(`k2:${k2},k1:${k1}`, 'k2');
    expect(decryptSecret(old, 'ws_1', rotated)).toBe('rotate-me');
    const fresh = reencryptSecret(old, 'ws_1', rotated);
    expect(envelopeKeyId(fresh)).toBe('k2');
    expect(() => decryptSecret(fresh, 'ws_1', ring)).toThrow(/not configured/);
  });

  it('validates keyring input', () => {
    expect(() => parseKeyring(undefined)).toThrow();
    expect(() => parseKeyring('k1:short')).toThrow(/32 bytes/);
    expect(() => parseKeyring(`k1:${k1}`, 'nope')).toThrow(/Active/);
  });
});
