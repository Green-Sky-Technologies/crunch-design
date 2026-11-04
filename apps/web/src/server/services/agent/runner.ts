/**
 * Wires the Vercel Sandbox runner to the app: it issues the job token and builds the job spec.
 * Nothing secret goes into the spec; the token is the only credential the sandbox sees.
 */
import {
  jobPrompt,
  jobToolNames,
  MODEL_TIERS,
  resolveModel,
  serializeDesignSystem,
  systemPromptFor,
} from '@crunch/agent';
import type { JobRunner, StartJob } from '@crunch/contracts';
import { agentMessages, eq, jobs, type Db } from '@crunch/db';
import { VercelSandboxRunner, type PreparedJob, type SandboxApi } from '@crunch/sandbox-runner';
import { getDoc } from '../design-docs';
import { jobActor } from '../jobs';
import { resolveProjectDesignSystem } from '../project-design-system';
import { getProject } from '../projects';
import { issueJobToken } from './job-tokens';
import { getModelSettings } from './model-settings';

/** Slack on top of the job timeout before its token expires. */
const TOKEN_SLACK_SECONDS = 10 * 60;

export async function prepareJob(db: Db, job: StartJob): Promise<PreparedJob> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, job.jobId)).limit(1);
  if (!row) throw new Error('Job not found');
  const actor = await jobActor(db, row);
  const settings = await getModelSettings(db, row.workspaceId);
  const [msg] = await db
    .select({ model: agentMessages.model })
    .from(agentMessages)
    .where(eq(agentMessages.jobId, row.id))
    .limit(1);
  const model = resolveModel(settings, 'generation', msg?.model);
  let smallModel: string;
  try {
    smallModel = resolveModel(settings, 'utility');
  } catch {
    smallModel = model;
  }
  let dsBlock = '';
  let doc = null;
  if (row.projectId) {
    const project = await getProject(db, actor, row.projectId);
    dsBlock = serializeDesignSystem((await resolveProjectDesignSystem(db, actor, project)).spec);
    doc = (await getDoc(db, actor, row.projectId)).doc;
  }
  const { token } = await issueJobToken(db, job.jobId, job.timeoutSeconds + TOKEN_SLACK_SECONDS);
  return {
    jobToken: token,
    model,
    smallModel: smallModel ?? MODEL_TIERS.utility,
    spec: {
      prompt: jobPrompt(job.kind, job.input, doc),
      systemPrompt: [systemPromptFor('job'), dsBlock].filter(Boolean).join('\n\n'),
      tools: jobToolNames(),
      maxTurns: 80,
    },
  };
}

export function appUrl(): string {
  const explicit = process.env.CRUNCH_APP_URL;
  if (explicit) return explicit;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`;
  return `http://localhost:${process.env.PORT ?? 3000}`;
}

const g = globalThis as unknown as { __crunchJobRunner?: JobRunner };

/** The app's JobRunner. Tests pass their own; `api` lets local dev inject a fake sandbox. */
export function jobRunner(db: Db, opts: { api?: SandboxApi } = {}): JobRunner {
  if (opts.api)
    return new VercelSandboxRunner({
      appUrl: appUrl(),
      api: opts.api,
      prepare: (j) => prepareJob(db, j),
    });
  return (g.__crunchJobRunner ??= new VercelSandboxRunner({
    appUrl: appUrl(),
    prepare: (j) => prepareJob(db, j),
  }));
}
