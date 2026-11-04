// @vitest-environment happy-dom
import type { OverlayApi } from '@crunch/contracts/canvas-overlay';
import { useCanvasOverlays } from '@crunch/contracts/canvas-overlay';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Thread } from './api';
import {
  CommentPins,
  COMMENT_OVERLAY_ID,
  pinPosition,
  useCommentPinsOverlay,
} from './comment-pins';
import { activeMentions, mentionQuery } from './mention-input';
import { overlayToCanvas, useCollab } from './store';

afterEach(() => {
  cleanup();
  useCollab.setState({ threads: [], focusedThreadId: null, showResolved: false, panel: null });
});

function fakeApi(rects: Record<string, { x: number; y: number; width: number; height: number }>) {
  const listeners = new Set<() => void>();
  const api: OverlayApi & { emit(): void } = {
    getNodeRect: (id) => rects[id] ?? null,
    canvasToOverlay: (p) => ({ x: p.x * 2 + 10, y: p.y * 2 + 20 }),
    zoom: 2,
    subscribe: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    projectId: 'p',
    readOnly: true,
    emit: () => listeners.forEach((l) => l()),
  };
  return api;
}

const thread = (over: Partial<Thread>): Thread => ({
  id: 't1',
  projectId: 'p',
  kind: 'discussion',
  status: 'open',
  anchor: { type: 'node', frameId: 'f_frame0001', nodeId: 'n_node000001' },
  fallback: { x: 5, y: 5 },
  orphaned: false,
  agentConversationId: null,
  createdBy: 'u',
  createdAt: new Date().toISOString(),
  resolvedBy: null,
  resolvedAt: null,
  comments: [
    {
      id: 'c1',
      authorType: 'user',
      authorId: 'u',
      authorName: 'U',
      body: 'Hi',
      mentions: [],
      createdAt: new Date().toISOString(),
    },
  ],
  ...over,
});

describe('comment pins', () => {
  it('anchors to the node rect, and falls back to the canvas position when orphaned', () => {
    const api = fakeApi({ n_node000001: { x: 100, y: 50, width: 40, height: 10 } });
    expect(pinPosition(api, thread({}))).toEqual({ x: 140, y: 50 });
    expect(pinPosition(api, thread({ orphaned: true }))).toEqual({ x: 20, y: 30 });
    expect(pinPosition(api, thread({ anchor: { type: 'canvas', x: 1, y: 2 } }))).toEqual({
      x: 12,
      y: 24,
    });
    // Node not rendered (e.g. other frame scrolled away) and no fallback: no pin.
    expect(pinPosition(fakeApi({}), thread({ fallback: null }))).toEqual(null);
  });

  it('round-trips overlay and canvas coordinates', () => {
    const api = fakeApi({});
    expect(overlayToCanvas(api, api.canvasToOverlay({ x: 33, y: -7 }))).toEqual({ x: 33, y: -7 });
  });

  it('renders open threads, follows node moves and focuses on click', () => {
    const rects = { n_node000001: { x: 100, y: 50, width: 40, height: 10 } };
    const api = fakeApi(rects);
    useCollab.setState({
      threads: [thread({}), thread({ id: 't2', status: 'resolved' })],
    });
    const { container } = render(<CommentPins api={api} />);
    const pins = container.querySelectorAll('[data-comment-pin]');
    expect(pins).toHaveLength(1);
    const pin = pins[0] as HTMLElement;
    expect(pin.style.left).toBe('140px');

    rects.n_node000001 = { x: 300, y: 50, width: 40, height: 10 };
    act(() => api.emit());
    expect(pin.style.left).toBe('340px');

    fireEvent.click(pin);
    expect(useCollab.getState().focusedThreadId).toBe('t1');
    expect(useCollab.getState().panel).toBe('comments');
  });

  it('registers itself with the canvas overlay registry', () => {
    let ids: string[] = [];
    function Probe() {
      ids = useCanvasOverlays().map((o) => o.id);
      return null;
    }
    function Host() {
      useCommentPinsOverlay();
      return null;
    }
    const { unmount } = render(
      <>
        <Host />
        <Probe />
      </>,
    );
    expect(ids).toContain(COMMENT_OVERLAY_ID);
    unmount();
  });
});

describe('mentions', () => {
  it('detects the @query at the caret', () => {
    expect(mentionQuery('hello @an', 9)).toEqual({ start: 6, query: 'an' });
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQuery('mail a@b', 8)).toBeNull();
    expect(mentionQuery('hello', 5)).toBeNull();
  });

  it('keeps only mentions still present in the text', () => {
    const picked = new Map([
      ['u1', 'Ann Lee'],
      ['u2', 'Bob'],
    ]);
    expect(activeMentions('hi @Ann Lee', picked)).toEqual(['u1']);
  });
});
