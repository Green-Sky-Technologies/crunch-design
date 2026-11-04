// @vitest-environment happy-dom
import type { OverlayApi, OverlayRect } from '@crunch/contracts/canvas-overlay';
import { applyOps, sampleLandingDoc, type DesignDoc } from '@crunch/doc-model';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { frameOfNode } from './anchor';
import type { Thread } from './api';
import { FALLBACK_DEBOUNCE_MS, liveAnchor, pinPosition, useRefreshFallbacks } from './comment-pins';

afterEach(cleanup);

const base = sampleLandingDoc();
const FRAME = base.frames[0]!.id;
const NODE = 'n_herotitle1';

/** Overlay API whose rects are keyed by frame, so it notices when a node changes frame. */
function frameAwareApi(rects: Record<string, OverlayRect>, readOnly = false) {
  const listeners = new Set<() => void>();
  return {
    getNodeRect: (id: string, frameId?: string) => rects[`${frameId}:${id}`] ?? null,
    // canvas -> overlay: pan (10, 20), zoom 2
    canvasToOverlay: (p: { x: number; y: number }) => ({ x: p.x * 2 + 10, y: p.y * 2 + 20 }),
    zoom: 2,
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    projectId: 'p',
    readOnly,
    emit: () => listeners.forEach((l) => l()),
  } satisfies OverlayApi & { emit(): void };
}

const thread = (over: Partial<Thread> = {}): Thread => ({
  id: 't1',
  projectId: 'p',
  kind: 'discussion',
  status: 'open',
  anchor: { type: 'node', frameId: FRAME, nodeId: NODE },
  fallback: { x: 0, y: 0 },
  orphaned: false,
  currentFrameId: FRAME,
  agentConversationId: null,
  createdBy: 'u',
  createdAt: new Date().toISOString(),
  resolvedBy: null,
  resolvedAt: null,
  comments: [],
  ...over,
});

/** The sample doc with a second frame, and NODE moved into it. */
function movedToNewFrame(): DesignDoc {
  return applyOps(base, [
    {
      op: 'insertFrame',
      index: 1,
      frame: {
        id: 'f_mobile00001',
        name: 'Mobile',
        rootNodeId: 'n_mobroot0001',
        canvas: { x: 2000, y: 0 },
        width: 390,
        height: 800,
        previewBreakpoints: [],
      },
      nodes: [
        {
          id: 'n_mobroot0001',
          type: 'box',
          tag: 'div',
          parentId: null,
          children: [],
          positioning: 'flow',
          style: {},
          props: {},
        },
      ],
    },
    { op: 'moveNode', id: NODE, parentId: 'n_mobroot0001', index: 0 },
  ]).doc;
}

describe('comments follow nodes across frames', () => {
  it('derives the current frame from the live doc', () => {
    const moved = movedToNewFrame();
    expect(frameOfNode(base, NODE)).toBe(FRAME);
    expect(frameOfNode(moved, NODE)).toBe('f_mobile00001');
    expect(liveAnchor(thread(), moved)).toEqual({ frameId: 'f_mobile00001', orphaned: false });
    const deleted = applyOps(base, [{ op: 'removeNode', id: NODE }]).doc;
    expect(liveAnchor(thread(), deleted)).toEqual({ frameId: null, orphaned: true });
  });

  it('pins to the node in its new frame instead of orphaning it', () => {
    const api = frameAwareApi({
      [`f_mobile00001:${NODE}`]: { x: 500, y: 40, width: 100, height: 20 },
    });
    // Server data is stale (old frame), but the live doc knows where the node is.
    expect(pinPosition(api, thread(), movedToNewFrame())).toEqual({ x: 600, y: 40 });
  });

  it('uses the server view (currentFrameId) when no live doc is available', () => {
    const api = frameAwareApi({ [`f_other000001:${NODE}`]: { x: 1, y: 2, width: 3, height: 4 } });
    expect(pinPosition(api, thread({ currentFrameId: 'f_other000001' }))).toEqual({ x: 4, y: 2 });
  });
});

describe('fallback refresh', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function Host(props: {
    api: OverlayApi;
    threads: Thread[];
    doc: DesignDoc | null;
    save: (id: string, p: { x: number; y: number }) => Promise<unknown>;
  }) {
    useRefreshFallbacks(props.api, props.threads, props.doc, !props.api.readOnly, props.save);
    return null;
  }

  it('keeps the fallback at the pin point (top-right) while the node is live, debounced', async () => {
    const rects: Record<string, OverlayRect> = {
      [`${FRAME}:${NODE}`]: { x: 110, y: 40, width: 200, height: 30 },
    };
    const api = frameAwareApi(rects);
    const save = vi.fn(async () => {});
    render(<Host api={api} threads={[thread()]} doc={base} save={save} />);
    expect(save).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(FALLBACK_DEBOUNCE_MS));
    // Pin point in overlay = (310, 40) -> canvas = ((310-10)/2, (40-20)/2) = (150, 10)
    expect(save).toHaveBeenLastCalledWith('t1', { x: 150, y: 10 });

    // The node moves (layout change): saved again after the debounce, never for tiny jitter.
    rects[`${FRAME}:${NODE}`] = { x: 410, y: 40, width: 200, height: 30 };
    act(() => api.emit());
    act(() => api.emit());
    await act(async () => vi.advanceTimersByTime(FALLBACK_DEBOUNCE_MS));
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith('t1', { x: 300, y: 10 });
    act(() => api.emit());
    await act(async () => vi.advanceTimersByTime(FALLBACK_DEBOUNCE_MS));
    expect(save).toHaveBeenCalledTimes(2); // unchanged position: no write
  });

  it('does not write for viewers or orphaned nodes', async () => {
    const save = vi.fn(async () => {});
    const rects = { [`${FRAME}:${NODE}`]: { x: 1, y: 1, width: 1, height: 1 } };
    render(<Host api={frameAwareApi(rects, true)} threads={[thread()]} doc={base} save={save} />);
    const deleted = applyOps(base, [{ op: 'removeNode', id: NODE }]).doc;
    render(<Host api={frameAwareApi(rects)} threads={[thread()]} doc={deleted} save={save} />);
    await act(async () => vi.advanceTimersByTime(FALLBACK_DEBOUNCE_MS * 2));
    expect(save).not.toHaveBeenCalled();
  });
});
