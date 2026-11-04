// @vitest-environment happy-dom
import { applyOps, sampleLandingDoc } from '@crunch/doc-model';
import { addFrameOps } from '@crunch/canvas';
import { act, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { frameChanged } from './canvas-pane';
import { CanvasPane } from './index';
import { frameRoot, renderEditor } from './test-utils';

afterEach(cleanup);

describe('render isolation between frames (Story 3.10)', () => {
  const base = sampleLandingDoc();
  const two = applyOps(base, addFrameOps(base, { name: 'Other' }).ops).doc;
  const other = two.frames[1]!;

  it('detects edits inside a frame, its frame record, and token overrides', () => {
    const styled = applyOps(two, [
      { op: 'setStyle', id: 'n_herotitle1', breakpoint: 'lg', prop: 'gap', value: 4 },
    ]).doc;
    expect(frameChanged(two, styled, 'f_desktop001')).toBe(true);
    expect(frameChanged(two, styled, other.id)).toBe(false);

    const removed = applyOps(two, [{ op: 'removeNode', id: 'n_herobody01' }]).doc;
    expect(frameChanged(two, removed, 'f_desktop001')).toBe(true);

    const renamed = applyOps(two, [{ op: 'updateFrame', id: other.id, patch: { name: 'X' } }]).doc;
    expect(frameChanged(two, renamed, other.id)).toBe(true);
    expect(frameChanged(two, renamed, 'f_desktop001')).toBe(false);

    const tokens = applyOps(two, [
      { op: 'setTokenOverride', path: 'color.primary', value: '#000000' },
    ]).doc;
    expect(frameChanged(two, tokens, other.id)).toBe(true);

    // moving a node between frames touches both
    const moved = applyOps(two, [
      { op: 'moveNode', id: 'n_herobody01', parentId: other.rootNodeId, index: 0 },
    ]).doc;
    expect(frameChanged(two, moved, 'f_desktop001')).toBe(true);
    expect(frameChanged(two, moved, other.id)).toBe(true);
  });

  it('frames still render edits that touch them, and moves across frames', async () => {
    const { store } = renderEditor(<CanvasPane />, { doc: two });
    // the first frame renders at once; the second mounts on a following task
    expect(frameRoot('f_desktop001')?.querySelector('[data-cd-id]')).toBeTruthy();
    await act(() => new Promise((r) => setTimeout(r, 60)));
    expect(frameRoot(other.id)?.querySelector('[data-cd-id]')).toBeTruthy();
    act(() => {
      store()
        .getState()
        .apply([{ op: 'moveNode', id: 'n_herobody01', parentId: other.rootNodeId, index: 0 }], {
          source: 'canvas',
        });
    });
    await act(async () => {});
    expect(frameRoot(other.id)?.querySelector('[data-cd-id="n_herobody01"]')).toBeTruthy();
    expect(frameRoot('f_desktop001')?.querySelector('[data-cd-id="n_herobody01"]')).toBeNull();
  });
});
