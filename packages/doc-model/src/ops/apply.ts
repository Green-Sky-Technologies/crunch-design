/**
 * Pure reducer for DesignDoc ops. Uses immer so unchanged nodes keep object identity, which
 * lets the renderer skip them (Story 2.3 incremental re-render).
 *
 * Contract:
 *   applyOps(doc, ops) -> { doc, inverse }
 *   applyOps(applyOps(doc, ops).doc, inverse).doc deep-equals doc
 * A transaction is atomic: if any op is invalid, OpError is thrown and the input is untouched.
 */
import {
  castDraft,
  current,
  enablePatches,
  isDraft,
  produce,
  setAutoFreeze,
  type Draft,
} from 'immer';
import {
  frame as frameSchema,
  LEAF_TYPES,
  node as nodeSchema,
  type DesignDoc,
  type Node,
} from '../schema';
import { isStyleProp, validateStyleValue } from '../styles';
import { docOp, OpError, type DocOp } from './types';

enablePatches();
// Docs are treated as immutable by convention; freezing every node costs time on large docs.
setAutoFreeze(false);

type D = Draft<DesignDoc>;

/** Deep copy that works on immer drafts (structuredClone can't copy Proxies). */
function clone<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  return structuredClone(isDraft(v) ? (current(v as Draft<T & object>) as T) : v);
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new OpError('not_found', `${what} not found`);
  return v;
}

function subtreeIds(d: D | DesignDoc, rootId: string): string[] {
  const out: string[] = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    const n = d.nodes[id];
    if (!n) continue;
    out.push(id);
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
  }
  return out;
}

/** Pre-order snapshot of a subtree (for inverses of removals). */
function snapshotSubtree(d: D, rootId: string): Node[] {
  return subtreeIds(d, rootId).map((id) => clone(d.nodes[id] as Node));
}

function revalidateNode(n: Node): Node {
  const r = nodeSchema.safeParse(n);
  if (!r.success) {
    throw new OpError('invalid_value', `Node ${n.id}: ${r.error.issues[0]?.message ?? 'invalid'}`);
  }
  return r.data;
}

function checkInsertable(d: D, parentId: string, index: number) {
  const parent = need(d.nodes[parentId], `Parent ${parentId}`);
  if (LEAF_TYPES.has(parent.type))
    throw new OpError('invalid_target', `${parent.type} nodes cannot have children`);
  if (index > parent.children.length)
    throw new OpError('invalid_target', `Index ${index} out of range`);
  return parent;
}

/** Validate an incoming pre-order subtree and attach it. Returns the root id. */
function attachSubtree(d: D, nodes: Node[], parentId: string | null): string {
  const root = nodes[0]!;
  const ids = new Set<string>();
  for (const n of nodes) {
    revalidateNode(n);
    if (ids.has(n.id)) throw new OpError('invalid_op', `Duplicate node id ${n.id} in subtree`);
    if (d.nodes[n.id]) throw new OpError('conflict', `Node id ${n.id} already exists`);
    ids.add(n.id);
  }
  // internal consistency: every child is in the subtree and points back
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    if (LEAF_TYPES.has(n.type) && n.children.length)
      throw new OpError('invalid_value', `${n.type} ${n.id} cannot have children`);
    for (const c of n.children) {
      const child = byId.get(c);
      if (!child || child.parentId !== n.id)
        throw new OpError('invalid_op', `Subtree child ${c} inconsistent`);
    }
    if (n !== root && !byId.get(n.parentId ?? ''))
      throw new OpError('invalid_op', `Subtree node ${n.id} detached`);
  }
  const reachable = new Set<string>();
  const stack = [root.id];
  while (stack.length) {
    const id = stack.pop()!;
    if (reachable.has(id)) throw new OpError('cycle', 'Cycle in subtree');
    reachable.add(id);
    stack.push(...byId.get(id)!.children);
  }
  if (reachable.size !== nodes.length)
    throw new OpError('invalid_op', 'Subtree contains unreachable nodes');

  for (const n of nodes) {
    const copy = clone(n);
    if (copy.id === root.id) copy.parentId = parentId;
    d.nodes[copy.id] = castDraft(copy);
  }
  return root.id;
}

function detachSubtree(d: D, rootId: string) {
  for (const id of subtreeIds(d, rootId)) delete d.nodes[id];
}

function applyOne(d: D, op: DocOp): DocOp[] {
  switch (op.op) {
    case 'insertSubtree': {
      const parent = checkInsertable(d, op.parentId, op.index);
      const rootId = attachSubtree(d, op.nodes, op.parentId);
      parent.children.splice(op.index, 0, rootId);
      return [{ op: 'removeNode', id: rootId }];
    }

    case 'removeNode': {
      const n = need(d.nodes[op.id], `Node ${op.id}`);
      if (n.parentId === null)
        throw new OpError('invalid_target', 'Cannot remove a frame root; remove the frame');
      const parent = need(d.nodes[n.parentId], `Parent ${n.parentId}`);
      const index = parent.children.indexOf(op.id);
      const snapshot = snapshotSubtree(d, op.id);
      parent.children.splice(index, 1);
      detachSubtree(d, op.id);
      // Drop slider bindings that pointed into the removed subtree? No: sliders are explicit;
      // the agent/canvas removes them in the same txn. Invariant checks flag dangling bindings.
      return [{ op: 'insertSubtree', parentId: parent.id, index, nodes: snapshot }];
    }

    case 'moveNode': {
      const n = need(d.nodes[op.id], `Node ${op.id}`);
      if (n.parentId === null) throw new OpError('invalid_target', 'Cannot move a frame root');
      if (subtreeIds(d, op.id).includes(op.parentId))
        throw new OpError('cycle', 'Cannot move a node into itself');
      const from = need(d.nodes[n.parentId], `Parent ${n.parentId}`);
      const fromIndex = from.children.indexOf(op.id);
      from.children.splice(fromIndex, 1);
      // On error immer discards the draft, so there's no need to restore `from`.
      const to = checkInsertable(d, op.parentId, op.index);
      to.children.splice(op.index, 0, op.id);
      n.parentId = op.parentId;
      return [{ op: 'moveNode', id: op.id, parentId: from.id, index: fromIndex }];
    }

    case 'setStyle': {
      const n = need(d.nodes[op.id], `Node ${op.id}`);
      const bp = (n.style[op.breakpoint] ??= {}) as Record<string, unknown>;
      const prev = bp[op.prop];
      if (op.value === null) {
        if (!isStyleProp(op.prop))
          throw new OpError('invalid_value', `Unknown style prop "${op.prop}"`);
        delete bp[op.prop];
        if (Object.keys(bp).length === 0) delete n.style[op.breakpoint];
      } else {
        const r = validateStyleValue(op.prop, op.value);
        if (!r.success)
          throw new OpError(
            'invalid_value',
            `${op.prop}: ${r.error.issues[0]?.message ?? 'invalid value'}`,
          );
        bp[op.prop] = clone(r.data);
      }
      return [
        {
          op: 'setStyle',
          id: op.id,
          breakpoint: op.breakpoint,
          prop: op.prop,
          value: prev === undefined ? null : clone(prev),
        },
      ];
    }

    case 'setProps': {
      const n = need(d.nodes[op.id], `Node ${op.id}`);
      const props = n.props as Record<string, unknown>;
      const inverse: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(op.patch)) {
        inverse[k] = k in props ? clone(props[k]) : null;
        if (v === null) delete props[k];
        else props[k] = clone(v);
      }
      revalidateNode(n as Node);
      return [{ op: 'setProps', id: op.id, patch: inverse }];
    }

    case 'setNodeMeta': {
      const n = need(d.nodes[op.id], `Node ${op.id}`) as Record<string, unknown> & Draft<Node>;
      const inverse: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(op.patch)) {
        if (v === undefined) continue;
        if (k === 'tag' && !('tag' in n))
          throw new OpError('invalid_target', `${n.type} nodes have no tag`);
        inverse[k] = k in n && n[k] !== undefined ? n[k] : k === 'positioning' ? 'flow' : null;
        if (v === null) delete n[k];
        else n[k] = v;
      }
      revalidateNode(n as Node);
      return [{ op: 'setNodeMeta', id: op.id, patch: inverse }];
    }

    case 'setInstance': {
      const n = need(d.nodes[op.id], `Node ${op.id}`);
      if (n.type !== 'instance')
        throw new OpError('invalid_target', 'setInstance targets instance nodes');
      const inv: {
        variant?: Record<string, string | null>;
        values?: Record<string, string | boolean | number | null>;
      } = {};
      if (op.variant) {
        inv.variant = {};
        for (const [k, v] of Object.entries(op.variant)) {
          inv.variant[k] = n.componentRef.variant[k] ?? null;
          if (v === null) delete n.componentRef.variant[k];
          else n.componentRef.variant[k] = v;
        }
      }
      if (op.values) {
        inv.values = {};
        for (const [k, v] of Object.entries(op.values)) {
          inv.values[k] = n.props.values[k] ?? null;
          if (v === null) delete n.props.values[k];
          else n.props.values[k] = v;
        }
      }
      revalidateNode(n as Node);
      return [{ op: 'setInstance', id: op.id, ...inv }];
    }

    case 'insertFrame': {
      if (d.frames.some((f) => f.id === op.frame.id))
        throw new OpError('conflict', `Frame ${op.frame.id} exists`);
      if (op.index > d.frames.length)
        throw new OpError('invalid_target', 'Frame index out of range');
      if (op.nodes[0]!.id !== op.frame.rootNodeId)
        throw new OpError('invalid_op', 'First node must be the frame root');
      if (op.nodes[0]!.parentId !== null)
        throw new OpError('invalid_op', 'Frame root must have no parent');
      const f = frameSchema.parse(op.frame);
      attachSubtree(d, op.nodes, null);
      d.frames.splice(op.index, 0, castDraft(clone(f)));
      return [{ op: 'removeFrame', id: f.id }];
    }

    case 'removeFrame': {
      const index = d.frames.findIndex((f) => f.id === op.id);
      if (index < 0) throw new OpError('not_found', `Frame ${op.id} not found`);
      const f = clone(d.frames[index]!) as DesignDoc['frames'][number];
      const nodes = snapshotSubtree(d, f.rootNodeId);
      detachSubtree(d, f.rootNodeId);
      d.frames.splice(index, 1);
      return [{ op: 'insertFrame', index, frame: f, nodes }];
    }

    case 'updateFrame': {
      const f = need(
        d.frames.find((x) => x.id === op.id),
        `Frame ${op.id}`,
      );
      const inverse: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(op.patch)) {
        if (v === undefined) continue;
        inverse[k] = clone((f as Record<string, unknown>)[k]);
        (f as Record<string, unknown>)[k] = clone(v);
      }
      frameSchema.parse(f);
      return [{ op: 'updateFrame', id: op.id, patch: inverse }];
    }

    case 'moveFrame': {
      const from = d.frames.findIndex((f) => f.id === op.id);
      if (from < 0) throw new OpError('not_found', `Frame ${op.id} not found`);
      if (op.index >= d.frames.length)
        throw new OpError('invalid_target', 'Frame index out of range');
      const [f] = d.frames.splice(from, 1);
      d.frames.splice(op.index, 0, f!);
      return [{ op: 'moveFrame', id: op.id, index: from }];
    }

    case 'upsertSlider': {
      const i = d.sliders.findIndex((s) => s.id === op.slider.id);
      for (const b of op.slider.bindings) {
        if ('nodeId' in b.target && !d.nodes[b.target.nodeId])
          throw new OpError('not_found', `Slider target ${b.target.nodeId} not found`);
      }
      if (i < 0) {
        const at = Math.min(op.index ?? d.sliders.length, d.sliders.length);
        d.sliders.splice(at, 0, castDraft(clone(op.slider)));
        return [{ op: 'removeSlider', id: op.slider.id }];
      }
      const prev = clone(d.sliders[i]!) as DesignDoc['sliders'][number];
      d.sliders[i] = castDraft(clone(op.slider));
      return [{ op: 'upsertSlider', slider: prev }];
    }

    case 'removeSlider': {
      const i = d.sliders.findIndex((s) => s.id === op.id);
      if (i < 0) throw new OpError('not_found', `Slider ${op.id} not found`);
      const prev = clone(d.sliders[i]!) as DesignDoc['sliders'][number];
      d.sliders.splice(i, 1);
      return [{ op: 'upsertSlider', slider: prev, index: i }];
    }

    case 'setSliderValue': {
      const s = need(
        d.sliders.find((x) => x.id === op.id),
        `Slider ${op.id}`,
      );
      if (op.value < s.min || op.value > s.max)
        throw new OpError('invalid_value', 'Slider value out of range');
      const prev = s.value;
      s.value = op.value;
      return [{ op: 'setSliderValue', id: op.id, value: prev }];
    }

    case 'setTokenOverride': {
      const prev = d.tokenOverrides[op.path];
      if (op.value === null) delete d.tokenOverrides[op.path];
      else d.tokenOverrides[op.path] = op.value;
      return [{ op: 'setTokenOverride', path: op.path, value: prev ?? null }];
    }
  }
}

export interface ApplyResult {
  doc: DesignDoc;
  /** Ops that undo this batch, already in the order they must be applied. */
  inverse: DocOp[];
}

/** Apply a batch atomically. Ops are validated with Zod first (they may come from untrusted clients or the agent). */
export function applyOps(doc: DesignDoc, rawOps: readonly unknown[]): ApplyResult {
  const ops = rawOps.map((raw, i) => {
    const r = docOp.safeParse(raw);
    if (!r.success)
      throw new OpError('invalid_op', `Op ${i}: ${r.error.issues[0]?.message ?? 'invalid'}`, i);
    return r.data;
  });
  const inverses: DocOp[][] = [];
  const next = produce(doc, (d) => {
    ops.forEach((op, i) => {
      try {
        inverses.push(applyOne(d, op));
      } catch (e) {
        if (e instanceof OpError) throw new OpError(e.code, `Op ${i} (${op.op}): ${e.message}`, i);
        throw e;
      }
    });
  });
  return { doc: next, inverse: inverses.reverse().flat() };
}

export const applyOp = (doc: DesignDoc, op: DocOp) => applyOps(doc, [op]);

/** Node ids an op touches directly (for incremental rendering and agent edit scoping). */
export function touchedNodeIds(op: DocOp): string[] {
  switch (op.op) {
    case 'insertSubtree':
      return [op.parentId, ...op.nodes.map((n) => n.id)];
    case 'insertFrame':
      return op.nodes.map((n) => n.id);
    case 'moveNode':
      return [op.id, op.parentId];
    case 'removeNode':
    case 'setStyle':
    case 'setProps':
    case 'setNodeMeta':
    case 'setInstance':
      return [op.id];
    default:
      return [];
  }
}
