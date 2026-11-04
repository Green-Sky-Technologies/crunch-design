/**
 * DesignDoc patch ops. Every mutation (canvas, inspector, slider, agent, restore, import)
 * is expressed as ops grouped into transactions. Ops are JSON-serializable, Zod-validated,
 * and invertible: `applyOp` returns the inverse op(s) that undo it exactly.
 */
import { z } from 'zod';
import { frame, id, node, slider } from '../schema';
import { breakpoint } from '../styles';
import { tokenPath } from '../values';

const index = z.number().int().min(0);

/** Insert a subtree: `nodes` in pre-order, the first is the root, with internally consistent children. */
export const insertSubtreeOp = z
  .object({
    op: z.literal('insertSubtree'),
    parentId: id,
    index,
    nodes: z.array(node).min(1).max(5000),
  })
  .strict();

/** Remove a node and its whole subtree. */
export const removeNodeOp = z.object({ op: z.literal('removeNode'), id }).strict();

/** Reparent or reorder. `index` is the position in the target parent after removal from the old one. */
export const moveNodeOp = z.object({ op: z.literal('moveNode'), id, parentId: id, index }).strict();

/** Set (or unset with `value: null`) one style prop at one breakpoint. */
export const setStyleOp = z
  .object({
    op: z.literal('setStyle'),
    id,
    breakpoint,
    prop: z.string().max(64),
    value: z.unknown().nullable(),
  })
  .strict();

/** Shallow-merge node props (`null` deletes a key). Re-validated against the node type. */
export const setPropsOp = z
  .object({ op: z.literal('setProps'), id, patch: z.record(z.string().max(64), z.unknown()) })
  .strict();

/** Node metadata. */
export const setNodeMetaOp = z
  .object({
    op: z.literal('setNodeMeta'),
    id,
    patch: z
      .object({
        name: z.string().max(120).nullable().optional(),
        hidden: z.boolean().nullable().optional(),
        locked: z.boolean().nullable().optional(),
        positioning: z.enum(['flow', 'absolute']).optional(),
        tag: z.string().max(20).optional(),
      })
      .strict(),
  })
  .strict();

/** Change an instance's variant selection and/or prop values (merge; null deletes). */
export const setInstanceOp = z
  .object({
    op: z.literal('setInstance'),
    id,
    variant: z.record(z.string().max(64), z.string().max(64).nullable()).optional(),
    values: z
      .record(
        z.string().max(64),
        z.union([z.string().max(20_000), z.boolean(), z.number()]).nullable(),
      )
      .optional(),
  })
  .strict();

export const insertFrameOp = z
  .object({ op: z.literal('insertFrame'), index, frame, nodes: z.array(node).min(1).max(5000) })
  .strict();
export const removeFrameOp = z.object({ op: z.literal('removeFrame'), id }).strict();
export const updateFrameOp = z
  .object({
    op: z.literal('updateFrame'),
    id,
    patch: frame
      .pick({ name: true, canvas: true, width: true, height: true, previewBreakpoints: true })
      .partial()
      .strict(),
  })
  .strict();
export const moveFrameOp = z.object({ op: z.literal('moveFrame'), id, index }).strict();

/** Insert (at `index`, default end) or replace a slider by id. */
export const upsertSliderOp = z
  .object({ op: z.literal('upsertSlider'), slider, index: index.optional() })
  .strict();
export const removeSliderOp = z.object({ op: z.literal('removeSlider'), id }).strict();
/** Move a slider. Its binding effects are separate setStyle/setTokenOverride ops in the same txn. */
export const setSliderValueOp = z
  .object({ op: z.literal('setSliderValue'), id, value: z.number() })
  .strict();

export const setTokenOverrideOp = z
  .object({
    op: z.literal('setTokenOverride'),
    path: tokenPath,
    value: z.union([z.string().max(400), z.number()]).nullable(),
  })
  .strict();

export const docOp = z.discriminatedUnion('op', [
  insertSubtreeOp,
  removeNodeOp,
  moveNodeOp,
  setStyleOp,
  setPropsOp,
  setNodeMetaOp,
  setInstanceOp,
  insertFrameOp,
  removeFrameOp,
  updateFrameOp,
  moveFrameOp,
  upsertSliderOp,
  removeSliderOp,
  setSliderValueOp,
  setTokenOverrideOp,
]);
export type DocOp = z.infer<typeof docOp>;
export type DocOpType = DocOp['op'];

export const OP_SOURCES = [
  'canvas',
  'inspector',
  'slider',
  'agent',
  'restore',
  'import',
  'system',
] as const;
export type OpSource = (typeof OP_SOURCES)[number];

/** A transaction is one undo step and one doc_ops row. */
export const transaction = z
  .object({
    id: z.string().min(8).max(64),
    ops: z.array(docOp).min(1).max(10_000),
    label: z.string().max(200).optional(),
    source: z.enum(OP_SOURCES),
  })
  .strict();
export type Transaction = z.infer<typeof transaction>;

export type OpErrorCode =
  | 'invalid_op'
  | 'not_found'
  | 'invalid_target'
  | 'cycle'
  | 'invalid_value'
  | 'conflict'
  | 'invalid_doc';

export class OpError extends Error {
  override name = 'OpError';
  constructor(
    public readonly code: OpErrorCode,
    message: string,
    public readonly opIndex?: number,
  ) {
    super(message);
  }
}
