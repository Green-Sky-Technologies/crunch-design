/**
 * Agent tool handlers (Story 5.3), shared by the interactive path and sandbox jobs.
 *
 * Every handler validates its input with the Zod schema from @crunch/contracts (AGENT_TOOLS).
 * Edits become DesignDoc ops, committed through the host as one transaction per call; the host
 * attributes the transaction to the agent message (server-side, never from the browser).
 */
import {
  AGENT_TOOLS,
  type AgentRuntime,
  type AgentToolInput,
  type AgentToolName,
  type LintDoc,
  type LintIssue,
} from '@crunch/contracts';
import {
  isStyleProp,
  touchedNodeIds,
  type DesignDoc,
  type DesignSystemSpec,
  type DocOp,
  type Frame,
} from '@crunch/doc-model';
import { lintDoc } from '@crunch/ds-lint';
import { z } from 'zod';
import { outline, subtree, subtreeIds } from './context';
import { stableStringify } from './stable';

/** Where tools read and write. The web app implements it over Postgres; tests use memory. */
export interface ToolHost {
  runtime: AgentRuntime;
  getDoc(): Promise<DesignDoc>;
  getDesignSystem(): Promise<DesignSystemSpec>;
  /** Commit ops as one agent transaction. Throws ToolError (or any Error) on rejection. */
  commit(ops: DocOp[], label: string): Promise<{ version: number; txnId: string }>;
  /** Restrict edits to one subtree (inline "ask agent", Story 5.7). */
  scope?: { rootNodeId: string; allowWider: boolean };
  /** Linter (defaults to @crunch/ds-lint). */
  lint?: LintDoc;
  /** Max ops per patch_nodes call (the interactive path keeps patches small). */
  maxOpsPerPatch?: number;
  /** Job-only capabilities; absent means "not available". */
  screenshotFrame?(input: AgentToolInput<'screenshot_frame'>): Promise<unknown>;
  captureUrl?(input: AgentToolInput<'capture_url'>): Promise<unknown>;
  getFigmaFrame?(input: AgentToolInput<'get_figma_frame'>): Promise<unknown>;
  /** Notified after a frame is created (job events, canvas focus). */
  onFrameCreated?(frame: Frame): void | Promise<void>;
}

export class ToolError extends Error {
  override name = 'ToolError';
}

export interface ToolResult {
  /** JSON text for the tool_result block. */
  content: string;
  isError: boolean;
  /** Node ids this call changed (empty for reads). */
  touched: string[];
  txnId?: string;
}

const ok = (data: unknown, touched: string[] = [], txnId?: string): ToolResult => ({
  content: typeof data === 'string' ? data : stableStringify(data),
  isError: false,
  touched,
  txnId,
});
const fail = (message: string): ToolResult => ({
  content: stableStringify({ error: message }),
  isError: true,
  touched: [],
});

export const DEFAULT_MAX_OPS_INTERACTIVE = 200;

/** Ops that change document-level state rather than nodes. */
const DOC_LEVEL_OPS = new Set<DocOp['op']>([
  'insertFrame',
  'removeFrame',
  'updateFrame',
  'moveFrame',
  'upsertSlider',
  'removeSlider',
  'setSliderValue',
  'setTokenOverride',
]);

/**
 * Check that ops stay inside the scope subtree. Inserted nodes count as inside when their
 * parent is. Returns a reason when the scope is violated.
 */
export function scopeViolation(doc: DesignDoc, rootNodeId: string, ops: DocOp[]): string | null {
  const allowed = subtreeIds(doc, rootNodeId);
  for (const [i, op] of ops.entries()) {
    if (DOC_LEVEL_OPS.has(op.op))
      return `op ${i} (${op.op}) changes the document outside ${rootNodeId}`;
    if (op.op === 'insertSubtree') {
      if (!allowed.has(op.parentId)) return `op ${i} inserts outside ${rootNodeId}`;
      for (const n of op.nodes) allowed.add(n.id);
      continue;
    }
    if (op.op === 'removeNode' && op.id === rootNodeId)
      return `op ${i} removes the scoped node itself`;
    if (op.op === 'moveNode' && op.id === rootNodeId) return `op ${i} moves the scoped node itself`;
    for (const id of touchedNodeIds(op))
      if (!allowed.has(id)) return `op ${i} (${op.op}) touches ${id}, outside ${rootNodeId}`;
  }
  return null;
}

/** Ids a set of ops changes (for patch-scope assertions and UI highlighting). */
export function opsTouched(ops: DocOp[]): string[] {
  return [...new Set(ops.flatMap(touchedNodeIds))];
}

function parse<N extends AgentToolName>(name: N, raw: unknown): AgentToolInput<N> {
  const r = (AGENT_TOOLS[name].input as z.ZodType).safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new ToolError(
      `Invalid input for ${name}: ${issue?.path.join('.') || '(root)'} ${issue?.message ?? ''}`.trim(),
    );
  }
  return r.data as AgentToolInput<N>;
}

function frameWithPlacement(doc: DesignDoc, input: AgentToolInput<'insert_frame'>['frame']): Frame {
  if (input.canvas) return input as Frame;
  // Place new frames to the right of the rightmost frame, top-aligned (alternatives line up).
  const GAP = 160;
  let x = 0;
  for (const f of doc.frames) x = Math.max(x, f.canvas.x + f.width + GAP);
  return { ...input, canvas: { x, y: 0 } } as Frame;
}

function summarizeDesignSystem(ds: DesignSystemSpec, sections: string[] | undefined) {
  const want = new Set(sections ?? ['tokens', 'components', 'guidelines']);
  const out: Record<string, unknown> = {};
  if (want.has('tokens')) out.tokens = ds.tokens;
  if (want.has('tokens') && Object.keys(ds.themes).length) out.themes = ds.themes;
  if (want.has('components'))
    out.components = Object.fromEntries(
      Object.entries(ds.components).map(([id, c]) => [
        id,
        { name: c.name, description: c.description, props: c.props, variants: c.variants },
      ]),
    );
  if (want.has('guidelines')) out.guidelines = ds.guidelines;
  return out;
}

function checkSliderTargets(
  doc: DesignDoc,
  ds: DesignSystemSpec,
  slider: AgentToolInput<'create_slider'>['slider'],
) {
  for (const b of slider.bindings) {
    if ('nodeId' in b.target) {
      if (!doc.nodes[b.target.nodeId])
        throw new ToolError(`Slider binding: node ${b.target.nodeId} not found`);
      if (!isStyleProp(b.target.prop))
        throw new ToolError(`Slider binding: unknown style prop ${b.target.prop}`);
    } else if (!ds.tokens[b.target.token]) {
      throw new ToolError(`Slider binding: unknown token ${b.target.token}`);
    }
  }
}

/** Execute one tool call. Never throws for model mistakes; they come back as error results. */
export async function executeTool(
  host: ToolHost,
  name: string,
  rawInput: unknown,
): Promise<ToolResult> {
  if (!(name in AGENT_TOOLS)) return fail(`Unknown tool: ${name}`);
  const toolName = name as AgentToolName;
  if (!AGENT_TOOLS[toolName].runtimes.includes(host.runtime))
    return fail(`${name} is only available in background jobs. Offer to start one instead.`);
  try {
    return await run(host, toolName, rawInput);
  } catch (e) {
    if (e instanceof ToolError) return fail(e.message);
    // Commit rejections (invalid ops, conflicts) are actionable for the model.
    if (e instanceof Error && ['ValidationError', 'OpError', 'ConflictError'].includes(e.name))
      return fail(e.message);
    throw e;
  }
}

async function run(host: ToolHost, name: AgentToolName, raw: unknown): Promise<ToolResult> {
  const scope = host.scope && !host.scope.allowWider ? host.scope : null;
  switch (name) {
    case 'get_outline': {
      const input = parse(name, raw);
      const doc = await host.getDoc();
      return ok(outline(doc, input));
    }
    case 'get_subtree': {
      const input = parse(name, raw);
      const doc = await host.getDoc();
      const res = subtree(doc, input.nodeId, { maxDepth: input.maxDepth });
      if (!res) throw new ToolError(`Node ${input.nodeId} not found`);
      return ok(res);
    }
    case 'patch_nodes': {
      const input = parse(name, raw);
      const max = host.maxOpsPerPatch;
      if (max && input.ops.length > max)
        throw new ToolError(
          `Too many ops (${input.ops.length} > ${max}) for a quick edit. Make a smaller change, or offer to start a generation job.`,
        );
      if (scope) {
        const doc = await host.getDoc();
        const why = scopeViolation(doc, scope.rootNodeId, input.ops);
        if (why)
          throw new ToolError(
            `Out of scope: ${why}. Only edit inside the selected element, or ask the user to approve a wider change.`,
          );
      }
      const res = await host.commit(input.ops, input.label);
      return ok(
        { ok: true, version: res.version, touched: opsTouched(input.ops) },
        opsTouched(input.ops),
        res.txnId,
      );
    }
    case 'insert_frame': {
      const input = parse(name, raw);
      if (scope)
        throw new ToolError('Out of scope: creating frames needs a wider change approval.');
      const doc = await host.getDoc();
      const frame = frameWithPlacement(doc, input.frame);
      const op: DocOp = { op: 'insertFrame', index: doc.frames.length, frame, nodes: input.nodes };
      const res = await host.commit([op], `Add frame “${frame.name}”`);
      await host.onFrameCreated?.(frame);
      const touched = input.nodes.map((n) => n.id);
      return ok(
        { ok: true, version: res.version, frameId: frame.id, canvas: frame.canvas },
        touched,
        res.txnId,
      );
    }
    case 'create_slider': {
      const input = parse(name, raw);
      const [doc, ds] = await Promise.all([host.getDoc(), host.getDesignSystem()]);
      checkSliderTargets(doc, ds, input.slider);
      if (scope) {
        const allowed = subtreeIds(doc, scope.rootNodeId);
        for (const b of input.slider.bindings)
          if (!('nodeId' in b.target) || !allowed.has(b.target.nodeId))
            throw new ToolError('Out of scope: slider bindings must target the selected element.');
      }
      const slider = { ...input.slider, createdBy: 'agent' as const };
      const res = await host.commit(
        [{ op: 'upsertSlider', slider }],
        `Add slider “${slider.label}”`,
      );
      return ok({ ok: true, version: res.version, sliderId: slider.id }, [], res.txnId);
    }
    case 'get_design_system': {
      const input = parse(name, raw);
      return ok(summarizeDesignSystem(await host.getDesignSystem(), input.sections));
    }
    case 'run_lint': {
      const input = parse(name, raw);
      const [doc, ds] = await Promise.all([host.getDoc(), host.getDesignSystem()]);
      const nodeIds = input.nodeIds ?? (scope ? [...subtreeIds(doc, scope.rootNodeId)] : undefined);
      const issues: LintIssue[] = (host.lint ?? lintDoc)(doc, ds, nodeIds ? { nodeIds } : {});
      const shown = issues
        .slice(0, 100)
        .map(({ fix: _fix, ...i }) => ({ ...i, hasFix: Boolean(_fix) }));
      return ok({ count: issues.length, issues: shown });
    }
    case 'screenshot_frame': {
      const input = parse(name, raw);
      if (!host.screenshotFrame) throw new ToolError('screenshot_frame is not available yet');
      return ok(await host.screenshotFrame(input));
    }
    case 'capture_url': {
      const input = parse(name, raw);
      if (!host.captureUrl) throw new ToolError('capture_url is not available yet');
      return ok(await host.captureUrl(input));
    }
    case 'get_figma_frame': {
      const input = parse(name, raw);
      if (!host.getFigmaFrame) throw new ToolError('get_figma_frame is not available yet');
      return ok(await host.getFigmaFrame(input));
    }
  }
}
