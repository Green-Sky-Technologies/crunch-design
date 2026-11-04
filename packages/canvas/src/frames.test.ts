import {
  applyOps,
  checkInvariants,
  initialDoc,
  sampleLandingDoc,
  starterDesignSystem,
} from '@crunch/doc-model';
import { describe, expect, it } from 'vitest';
import {
  addFrameOps,
  cloneSubtree,
  duplicateFrameOps,
  frameBreakpoint,
  frameOfNode,
  frameRect,
  nextFramePosition,
  nodeFrameIndex,
} from './frames';

describe('frames', () => {
  it('adds a frame to the right of existing frames with a unique name', () => {
    const doc = initialDoc();
    const { ops, frameId } = addFrameOps(doc, { name: 'Desktop', width: 390 });
    const next = applyOps(doc, ops).doc;
    expect(checkInvariants(next)).toEqual([]);
    const f = next.frames.find((x) => x.id === frameId)!;
    expect(f.name).toBe('Desktop 2');
    expect(f.width).toBe(390);
    expect(f.canvas.x).toBe(1280 + 160);
    // undo removes it again
    expect(applyOps(next, applyOps(doc, ops).inverse).doc).toEqual(doc);
  });

  it('duplicates a frame with fresh ids and identical structure', () => {
    const doc = sampleLandingDoc();
    const src = doc.frames[0]!;
    const r = duplicateFrameOps(doc, src.id)!;
    const next = applyOps(doc, r.ops).doc;
    expect(checkInvariants(next)).toEqual([]);
    const copy = next.frames.find((f) => f.id === r.frameId)!;
    expect(copy.name).toBe(`${src.name} copy`);
    expect(copy.rootNodeId).not.toBe(src.rootNodeId);
    expect(Object.keys(next.nodes).length).toBe(Object.keys(doc.nodes).length * 2);
    expect(next.frames.map((f) => f.id)).toEqual([src.id, copy.id]);
    expect(duplicateFrameOps(doc, 'f_missing000')).toBeNull();
  });

  it('clones subtrees with consistent parent/child links', () => {
    const doc = sampleLandingDoc();
    const { nodes, idMap } = cloneSubtree(doc, 'n_hero000001', 'n_root000001');
    expect(nodes[0]!.parentId).toBe('n_root000001');
    expect(nodes.length).toBe(idMap.size);
    for (const n of nodes.slice(1)) expect(nodes.some((p) => p.children.includes(n.id))).toBe(true);
  });

  it('maps nodes to frames', () => {
    const doc = sampleLandingDoc();
    expect(nodeFrameIndex(doc).get('n_herotitle1')).toBe('f_desktop001');
    expect(frameOfNode(doc, 'n_herotitle1')?.id).toBe('f_desktop001');
    expect(frameOfNode(doc, 'n_nope000000')).toBeUndefined();
  });

  it('derives the breakpoint and rect of a frame', () => {
    const ds = starterDesignSystem();
    expect(frameBreakpoint({ width: 390 }, ds)).toBe('base');
    expect(frameBreakpoint({ width: 768 }, ds)).toBe('md');
    expect(frameBreakpoint({ width: 1280 }, ds)).toBe('lg');
    const f = sampleLandingDoc().frames[0]!;
    expect(frameRect(f).height).toBe(800);
    expect(frameRect(f, { [f.id]: { width: 1280, height: 2100 } }).height).toBe(2100);
    expect(nextFramePosition({ ...initialDoc(), frames: [] })).toEqual({ x: 0, y: 0 });
  });
});
