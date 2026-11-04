/** In-memory ToolHost over applyOps, for tests and the eval harness. */
import {
  applyOps,
  checkInvariants,
  type DesignDoc,
  type DesignSystemSpec,
  type DocOp,
} from '@crunch/doc-model';
import type { AgentRuntime } from '@crunch/contracts';
import { ToolError, type ToolHost } from './tools';

export interface MemoryHost extends ToolHost {
  doc: DesignDoc;
  version: number;
  /** Every committed transaction, in order. */
  commits: { ops: DocOp[]; label: string }[];
}

export function memoryHost(
  doc: DesignDoc,
  ds: DesignSystemSpec,
  opts: Partial<Pick<ToolHost, 'scope' | 'maxOpsPerPatch' | 'lint'>> & {
    runtime?: AgentRuntime;
  } = {},
): MemoryHost {
  const host: MemoryHost = {
    runtime: opts.runtime ?? 'interactive',
    scope: opts.scope,
    maxOpsPerPatch: opts.maxOpsPerPatch,
    lint: opts.lint,
    doc,
    version: 0,
    commits: [],
    getDoc: async () => host.doc,
    getDesignSystem: async () => ds,
    async commit(ops, label) {
      let next: DesignDoc;
      try {
        next = applyOps(host.doc, ops).doc;
      } catch (e) {
        throw new ToolError((e as Error).message);
      }
      const issues = checkInvariants(next);
      if (issues.length) throw new ToolError(`Invalid document: ${issues[0]!.message}`);
      host.doc = next;
      host.version++;
      host.commits.push({ ops, label });
      return { version: host.version, txnId: `mem-${host.version}` };
    },
  };
  return host;
}
