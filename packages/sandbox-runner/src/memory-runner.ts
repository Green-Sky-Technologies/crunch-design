/** Fakes for tests and local development without Vercel credentials. */
import type { JobRunner, StartJob } from '@crunch/contracts';
import type { CreateSandboxParams, SandboxApi, SandboxHandle } from './runner';

/** A JobRunner that only records calls. `alive` controls isAlive per sandbox. */
export class MemoryJobRunner implements JobRunner {
  started: StartJob[] = [];
  cancelled: string[] = [];
  alive = new Map<string, boolean>();
  failNextStart: Error | null = null;
  private n = 0;

  async start(job: StartJob) {
    if (this.failNextStart) {
      const e = this.failNextStart;
      this.failNextStart = null;
      throw e;
    }
    this.started.push(job);
    const sandboxId = `mem-sbx-${++this.n}`;
    this.alive.set(sandboxId, true);
    return { sandboxId };
  }
  async cancel(_jobId: string, sandboxId: string) {
    this.cancelled.push(sandboxId);
    this.alive.set(sandboxId, false);
  }
  async isAlive(sandboxId: string) {
    return this.alive.get(sandboxId) ?? false;
  }
}

export interface RecordedSandbox {
  params: CreateSandboxParams;
  files: { path: string; content: string; mode?: number }[];
  commands: unknown[];
  stopped: boolean;
}

/** A SandboxApi that records everything sent to "the VM" (for secret-leak tests). */
export function recordingSandboxApi(): SandboxApi & { sandboxes: Map<string, RecordedSandbox> } {
  const sandboxes = new Map<string, RecordedSandbox>();
  let n = 0;
  const handle = (name: string): SandboxHandle => {
    const rec = sandboxes.get(name)!;
    return {
      name,
      get status() {
        return rec.stopped ? 'stopped' : 'running';
      },
      async writeFiles(files) {
        for (const f of files)
          rec.files.push({
            path: f.path,
            content:
              typeof f.content === 'string' ? f.content : Buffer.from(f.content).toString('utf8'),
            mode: f.mode,
          });
      },
      async runCommand(params) {
        rec.commands.push(params);
        return {};
      },
      async stop() {
        rec.stopped = true;
        return {};
      },
    };
  };
  return {
    sandboxes,
    async create(params) {
      const name = `rec-sbx-${++n}`;
      sandboxes.set(name, {
        params: structuredClone(params),
        files: [],
        commands: [],
        stopped: false,
      });
      return handle(name);
    },
    async get(name) {
      if (!sandboxes.has(name)) throw new Error('not found');
      return handle(name);
    },
  };
}
