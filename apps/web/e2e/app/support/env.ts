/**
 * Environment for the app suite. Locally the keys come from apps/web/.env.local (the same file
 * `next start` reads); in CI they're plain environment variables. Only Clerk development keys
 * are accepted: the suite creates and deletes real users and organizations.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let loaded = false;
export function loadEnv() {
  if (loaded) return;
  loaded = true;
  const file = path.join(WEB_DIR, '.env.local');
  if (fs.existsSync(file)) process.loadEnvFile(file); // never overrides variables already set
  process.env.CLERK_PUBLISHABLE_KEY ??= process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
}

export function clerkKeys(): { publishableKey: string; secretKey: string } {
  loadEnv();
  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY ?? '';
  const secretKey = process.env.CLERK_SECRET_KEY ?? '';
  if (!publishableKey.startsWith('pk_test_') || !secretKey.startsWith('sk_test_'))
    throw new Error(
      'The app e2e suite needs Clerk development keys (pk_test_/sk_test_) in ' +
        'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY / CLERK_SECRET_KEY or apps/web/.env.local.',
    );
  return { publishableKey, secretKey };
}

/** Where run state (Clerk ids, signed-in storage states) lives: inside Playwright's output dir. */
export const STATE_DIR = path.join(WEB_DIR, 'test-results', '.e2e-app');
export const STATE_FILE = path.join(STATE_DIR, 'run.json');
export const storageStatePath = (role: string) => path.join(STATE_DIR, `${role}.storage.json`);
