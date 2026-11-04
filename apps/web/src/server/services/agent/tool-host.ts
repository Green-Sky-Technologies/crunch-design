/**
 * ToolHost over Postgres: agent tools read the persisted DesignDoc and commit transactions with
 * source 'agent' attributed to an agent message (Story 5.3 AC). Used by the interactive path and
 * by the job tool API that sandboxes call.
 */
import type { ToolHost } from '@crunch/agent';
import type { AgentRuntime } from '@crunch/contracts';
import { assertCan } from '@crunch/authz';
import { agentMessages, eq, sql, type Db } from '@crunch/db';
import {
  newId,
  type DesignDoc,
  type DesignSystemSpec,
  type DocOp,
  type Frame,
} from '@crunch/doc-model';
import { commitTransaction, ConflictError, getDoc } from '../design-docs';
import { resolveProjectDesignSystem } from '../project-design-system';
import { getProject } from '../projects';
import type { Actor } from '../types';

export interface DbToolHostOptions {
  projectId: string;
  /** The assistant message the transactions belong to. */
  agentMessageId: string;
  runtime: AgentRuntime;
  scope?: ToolHost['scope'];
  maxOpsPerPatch?: number;
  /** Runs once, before the first transaction (auto snapshot, Story 5.12). */
  beforeFirstCommit?: () => Promise<void>;
  onCommit?: (r: { txnId: string; version: number; ops: DocOp[] }) => void | Promise<void>;
  onFrameCreated?: (frame: Frame) => void | Promise<void>;
}

export const agentTxnId = () => `agent-${newId('s').slice(2)}`;

export async function createDbToolHost(
  db: Db,
  actor: Actor,
  opts: DbToolHostOptions,
): Promise<ToolHost> {
  assertCan(actor.role, 'agent:run');
  const project = await getProject(db, actor, opts.projectId);
  let state: { version: number; doc: DesignDoc } | null = null;
  let ds: DesignSystemSpec | null = null;
  let committed = false;

  const load = async () => (state ??= await getDoc(db, actor, opts.projectId));

  return {
    runtime: opts.runtime,
    scope: opts.scope,
    maxOpsPerPatch: opts.maxOpsPerPatch,
    onFrameCreated: opts.onFrameCreated,
    getDoc: async () => (await load()).doc,
    getDesignSystem: async () =>
      (ds ??= (await resolveProjectDesignSystem(db, actor, project)).spec),
    async commit(ops, label) {
      if (!committed) {
        await opts.beforeFirstCommit?.();
        committed = true;
      }
      const txn = { id: agentTxnId(), source: 'agent' as const, label: label.slice(0, 200), ops };
      let result;
      try {
        result = await commitTransaction(db, actor, opts.projectId, {
          baseVersion: (await load()).version,
          txn,
          agentMessageId: opts.agentMessageId,
        });
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
        // Someone else wrote meanwhile: ops are re-validated against the latest doc.
        state = null;
        result = await commitTransaction(db, actor, opts.projectId, {
          baseVersion: (await load()).version,
          txn,
          agentMessageId: opts.agentMessageId,
        });
      }
      state = null;
      await db
        .update(agentMessages)
        .set({ txnIds: sql`array_append(${agentMessages.txnIds}, ${result.txnId})` })
        .where(eq(agentMessages.id, opts.agentMessageId));
      await opts.onCommit?.({ txnId: result.txnId, version: result.version, ops });
      return { version: result.version, txnId: result.txnId };
    },
  };
}
