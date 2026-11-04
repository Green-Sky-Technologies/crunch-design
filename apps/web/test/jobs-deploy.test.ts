/** Deployment wiring for jobs: cron schedule and auth, callback URL, lost starts (review #4, #7). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, jobs } from '@crunch/db';
import { MemoryJobRunner, recordingSandboxApi, VercelSandboxRunner } from '@crunch/sandbox-runner';
import { cronAuthorized } from '@/server/services/agent/cron';
import { appUrl } from '@/server/services/agent/runner';
import { createJob, reapJobs } from '@/server/services/jobs';
import { createProject } from '@/server/services/projects';
import { makeActor, reset, testDb } from './helpers';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

describe('cron', () => {
  it('schedules the reaper in apps/web/vercel.json (daily: the Hobby plan limit)', () => {
    const cfg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../vercel.json', import.meta.url)), 'utf8'),
    );
    // Daily so free-tier deploys succeed; job status reads also run the reaper about once a
    // minute (opportunistic-reap.ts).
    expect(cfg.crons).toContainEqual({ path: '/api/jobs/reap', schedule: '0 4 * * *' });
  });

  it('accepts exactly the header Vercel Cron sends, and stays closed without a secret', () => {
    expect(cronAuthorized('Bearer s3cret', 's3cret')).toBe(true);
    expect(cronAuthorized('Bearer wrong', 's3cret')).toBe(false);
    expect(cronAuthorized('s3cret', 's3cret')).toBe(false);
    expect(cronAuthorized(null, 's3cret')).toBe(false);
    expect(cronAuthorized('Bearer ', '')).toBe(false);
    expect(cronAuthorized('Bearer undefined', undefined)).toBe(false);
  });

  it('the reaper starts a queued job whose after() start was lost', async () => {
    const editor = await makeActor(db, 'editor');
    const project = await createProject(db, editor, { name: 'P' });
    const job = await createJob(db, editor, {
      kind: 'generate',
      input: { prompt: 'x', frameCount: 1 },
      projectId: project.id,
    });
    const runner = new MemoryJobRunner();
    // Too fresh: the original after() may still be starting it.
    expect((await reapJobs(db, { runner })).started).toEqual([]);
    const res = await reapJobs(db, { runner, now: () => new Date(Date.now() + 60_000) });
    expect(res.started).toEqual([job.id]);
    expect((await db.select().from(jobs).where(eq(jobs.id, job.id)))[0]!.status).toBe('running');
  });
});

describe('sandbox callback URL', () => {
  it('previews call back to themselves, never to production', () => {
    expect(appUrl({ CRUNCH_APP_URL: 'https://app.example.com/' })).toBe('https://app.example.com');
    expect(
      appUrl({
        VERCEL_ENV: 'preview',
        VERCEL_URL: 'pr-1.vercel.app',
        VERCEL_PROJECT_PRODUCTION_URL: 'crunch.app',
      }),
    ).toBe('https://pr-1.vercel.app');
    expect(
      appUrl({
        VERCEL_ENV: 'production',
        VERCEL_URL: 'x-123.vercel.app',
        VERCEL_PROJECT_PRODUCTION_URL: 'crunch.app',
      }),
    ).toBe('https://crunch.app');
    expect(appUrl({ PORT: '3012' })).toBe('http://localhost:3012');
  });

  it('brokers the protection-bypass secret at the firewall, outside the VM', async () => {
    const api = recordingSandboxApi();
    const runner = new VercelSandboxRunner({
      appUrl: 'https://pr-1.vercel.app',
      api,
      protectionBypassSecret: 'bypass-SECRET-value',
      prepare: async () => ({
        jobToken: 'cjt_x',
        model: 'claude-opus-5-5',
        smallModel: 'claude-haiku-5-5',
        spec: { prompt: 'p', systemPrompt: 's', tools: [], maxTurns: 1 },
      }),
    });
    const { sandboxId } = await runner.start({
      jobId: 'j',
      workspaceId: 'w',
      kind: 'generate',
      input: {},
      timeoutSeconds: 60,
    });
    const rec = api.sandboxes.get(sandboxId)!;
    expect(rec.params.networkPolicy.allow).toEqual({
      'pr-1.vercel.app': [
        { transform: [{ headers: { 'x-vercel-protection-bypass': 'bypass-SECRET-value' } }] },
      ],
      'registry.npmjs.org': [],
    });
    const insideVm = JSON.stringify({
      env: rec.params.env,
      files: rec.files,
      commands: rec.commands,
    });
    expect(insideVm).not.toContain('bypass-SECRET-value');
  });
});
