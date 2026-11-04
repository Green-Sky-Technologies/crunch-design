/**
 * Envelope encryption for secrets at rest (provider credentials).
 *
 * - Each secret gets a fresh 256-bit data key (DEK), used once with AES-256-GCM.
 * - The DEK is wrapped with a master key (KEK) from the environment, also AES-256-GCM.
 * - Both layers bind `aad` (e.g. the workspace id), so a ciphertext copied onto another
 *   row fails to decrypt.
 * - Master keys carry an id so they can be rotated: new writes use the active key, and
 *   old ciphertexts stay decryptable while their key is still configured.
 *
 * Format (all base64url, colon separated):
 *   v1:<kekId>:<wrapIv>:<wrappedDek+tag>:<dataIv>:<ciphertext+tag>
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALG = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface Keyring {
  activeKeyId: string;
  keys: Map<string, Buffer>;
}

export class CryptoError extends Error {
  override name = 'CryptoError';
}

/**
 * Parse a keyring from env-style strings.
 * @param spec "kid1:<base64 32 bytes>,kid2:<base64 32 bytes>"
 * @param activeKeyId id used for new encryptions (defaults to the first entry)
 */
export function parseKeyring(spec: string | undefined, activeKeyId?: string): Keyring {
  if (!spec) throw new CryptoError('CREDENTIALS_MASTER_KEYS is not set');
  const keys = new Map<string, Buffer>();
  for (const entry of spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const idx = entry.indexOf(':');
    if (idx <= 0) throw new CryptoError('Malformed master key entry (expected id:base64)');
    const id = entry.slice(0, idx);
    const key = Buffer.from(entry.slice(idx + 1), 'base64');
    if (key.length !== KEY_BYTES) throw new CryptoError(`Master key "${id}" must be 32 bytes`);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new CryptoError(`Invalid master key id "${id}"`);
    keys.set(id, key);
  }
  const first = keys.keys().next().value;
  const active = activeKeyId || first;
  if (!active || !keys.has(active)) throw new CryptoError('Active master key id not found');
  return { activeKeyId: active, keys };
}

let cached: Keyring | undefined;
/** Keyring from process env, cached. */
export function envKeyring(): Keyring {
  cached ??= parseKeyring(
    process.env.CREDENTIALS_MASTER_KEYS,
    process.env.CREDENTIALS_ACTIVE_KEY_ID || undefined,
  );
  return cached;
}

/** Generate a new base64 master key (for `pnpm keygen`). */
export function generateMasterKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

const b64 = (b: Buffer) => b.toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');

function seal(key: Buffer, plaintext: Buffer, aad: Buffer): [Buffer, Buffer] {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return [iv, ct];
}

function open(key: Buffer, iv: Buffer, ctWithTag: Buffer, aad: Buffer): Buffer {
  if (ctWithTag.length < TAG_BYTES) throw new CryptoError('Ciphertext too short');
  const tag = ctWithTag.subarray(ctWithTag.length - TAG_BYTES);
  const ct = ctWithTag.subarray(0, ctWithTag.length - TAG_BYTES);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new CryptoError('Decryption failed (wrong key, wrong context, or tampered data)');
  }
}

export function encryptSecret(
  plaintext: string,
  aad: string,
  keyring: Keyring = envKeyring(),
): string {
  const kek = keyring.keys.get(keyring.activeKeyId)!;
  const aadBuf = Buffer.from(aad, 'utf8');
  const dek = randomBytes(KEY_BYTES);
  try {
    const [wrapIv, wrapped] = seal(kek, dek, aadBuf);
    const [dataIv, ct] = seal(dek, Buffer.from(plaintext, 'utf8'), aadBuf);
    return [VERSION, keyring.activeKeyId, b64(wrapIv), b64(wrapped), b64(dataIv), b64(ct)].join(
      ':',
    );
  } finally {
    dek.fill(0);
  }
}

export function decryptSecret(
  envelope: string,
  aad: string,
  keyring: Keyring = envKeyring(),
): string {
  const parts = envelope.split(':');
  if (parts.length !== 6 || parts[0] !== VERSION) throw new CryptoError('Unknown envelope format');
  const [, kekId, wrapIv, wrapped, dataIv, ct] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const kek = keyring.keys.get(kekId);
  if (!kek) throw new CryptoError(`Master key "${kekId}" is not configured`);
  const aadBuf = Buffer.from(aad, 'utf8');
  const dek = open(kek, unb64(wrapIv), unb64(wrapped), aadBuf);
  try {
    return open(dek, unb64(dataIv), unb64(ct), aadBuf).toString('utf8');
  } finally {
    dek.fill(0);
  }
}

/** Key id an envelope was written with, for finding records that need re-encrypting after a rotation. */
export function envelopeKeyId(envelope: string): string | undefined {
  return envelope.split(':')[1];
}

/** Re-wrap under the active key (rotation). */
export function reencryptSecret(
  envelope: string,
  aad: string,
  keyring: Keyring = envKeyring(),
): string {
  return encryptSecret(decryptSecret(envelope, aad, keyring), aad, keyring);
}
