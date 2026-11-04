#!/usr/bin/env node
/**
 * The Vercel build (apps/web/vercel.json → buildCommand). Before `next build` it:
 *  1. applies database migrations: on production deploys always, on previews only with
 *     MIGRATE_ON_PREVIEW=1 (set it when previews get their own database branch, e.g. the Neon
 *     integration's per-preview branches; otherwise a preview would migrate production);
 *  2. configures Clerk (organizations, roles) with CLERK_SECRET_KEY. Idempotent; a failure here
 *     only warns, because a misconfigured Clerk shouldn't block a deploy.
 * Then it checks the required configuration so a missing variable fails the build with a clear
 * message instead of a 500 at runtime.
 */
import { execSync } from 'node:child_process';
import { setupClerk } from './setup-clerk.mjs';

const env = process.env;
const run = (cmd, cwd) => execSync(cmd, { stdio: 'inherit', cwd, env });
const root = new URL('..', import.meta.url).pathname;
const web = new URL('../apps/web', import.meta.url).pathname;
const isProd = env.VERCEL_ENV === 'production';

const missing = [
  'DATABASE_URL',
  'CLERK_SECRET_KEY',
  'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
  'CREDENTIALS_MASTER_KEYS',
].filter((k) => !env[k]);
if (missing.length) {
  console.error(
    `\nMissing environment variables: ${missing.join(', ')}\n` +
      'See the "Deploy to Vercel" section of README.md.\n',
  );
  process.exit(1);
}
if (!env.CRON_SECRET)
  console.warn('⚠ CRON_SECRET is not set: stuck background jobs will not be cleaned up.');

if (isProd || env.MIGRATE_ON_PREVIEW === '1') {
  console.log('▸ Applying database migrations');
  run('pnpm --filter @crunch/db migrate', root);
} else {
  console.log('▸ Skipping migrations on this preview (set MIGRATE_ON_PREVIEW=1 to run them)');
}

if (isProd) {
  console.log('▸ Configuring Clerk');
  try {
    await setupClerk();
  } catch (e) {
    console.warn(`⚠ Clerk setup failed (${e.message}). Run \`pnpm setup:clerk\` to retry.`);
  }
}

console.log('▸ next build');
run('pnpm next build', web);
