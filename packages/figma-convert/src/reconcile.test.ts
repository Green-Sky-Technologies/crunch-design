import { describe, expect, it } from 'vitest';
import { planRemoval, type LiveNode } from './reconcile';

const m = (id: string, children: LiveNode[] = [], opaque = false): LiveNode => ({
  id,
  managed: true,
  children,
  opaque,
});
const u = (id: string, children: LiveNode[] = []): LiveNode => ({ id, managed: false, children });

describe('planRemoval', () => {
  it('moves hand-made layers out of removed nodes to the nearest kept ancestor', () => {
    const tree = m('root', [
      m('card', [
        m('title'),
        u('user-note', [u('user-child')]),
        m('stale-inner', [u('deep-user')]),
      ]),
      m('kept', [u('user-in-kept')]),
    ]);
    const plan = planRemoval(tree, new Set(['card', 'stale-inner']));
    expect(plan.removeRoots).toEqual(['card']);
    expect(plan.rescue).toEqual([
      { nodeId: 'title', toParentId: 'root' }, // still wanted elsewhere (not in the remove set)
      { nodeId: 'user-note', toParentId: 'root' }, // topmost only: its child moves with it
      { nodeId: 'deep-user', toParentId: 'root' },
    ]);
  });

  it('keeps nested removals inside a kept parent and ignores opaque nodes', () => {
    const tree = m('root', [m('kept', [m('stale', [u('mine')]), m('svg', [u('path')], true)])]);
    expect(planRemoval(tree, new Set(['stale', 'svg']))).toEqual({
      removeRoots: ['stale', 'svg'],
      rescue: [{ nodeId: 'mine', toParentId: 'kept' }],
    });
  });

  it('never removes the root itself', () => {
    expect(() => planRemoval(m('root'), new Set(['root']))).toThrow();
  });
});
