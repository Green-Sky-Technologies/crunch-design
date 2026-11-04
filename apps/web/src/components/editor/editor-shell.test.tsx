// @vitest-environment happy-dom
import { permissionsForProject } from '@crunch/authz';
import { applyOps, initialDoc, starterDesignSystem, type DesignDoc } from '@crunch/doc-model';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLockApi } from '@/features/canvas/lock';
import { grantingLockApi } from '@/features/canvas/test-utils';
import { EditorProvider, type DocApi } from '@/features/doc-store';
import { EditorShell } from './editor-shell';

vi.mock('@clerk/nextjs', () => ({ UserButton: () => null }));

// happy-dom has no layout, so stand in for the canvas hit-test with the page's root node.
const hit = vi.hoisted(() => ({ target: null as null | { frameId: string; nodeId: string } }));
vi.mock('@/features/canvas/dom', async (orig) => {
  const mod = await orig<typeof import('@/features/canvas/dom')>();
  return {
    ...mod,
    hitFromPoint: () => (hit.target ? { ...hit.target, el: document.body } : null),
  };
});

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// The shell now hosts the canvas lock controller and the collab panel; keep them off the network.
beforeEach(() => {
  setLockApi(grantingLockApi);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(role: 'editor' | 'viewer', archived = false, agentAvailable = false) {
  let doc: DesignDoc = initialDoc();
  let version = 0;
  const commits: number[] = [];
  const api: DocApi = {
    fetchDoc: async () => ({ version, doc }),
    commit: async (_p, body) => {
      doc = applyOps(doc, body.txn.ops).doc;
      version++;
      commits.push(body.txn.ops.length);
      return { ok: true, version };
    },
    since: async () => ({ version, txns: [], reset: false }),
  };
  const initial = { version, doc };
  render(
    <EditorProvider
      api={api}
      pollMs={1_000_000}
      initial={initial}
      info={{
        project: {
          id: '00000000-0000-4000-8000-000000000001',
          name: 'Landing',
          description: null,
          archived,
        },
        workspace: { id: 'w', slug: 'acme', name: 'Acme' },
        user: { id: 'u', role },
        permissions: permissionsForProject(role, { archived }),
        designSystem: { id: 'd', name: 'Starter', version: null, spec: starterDesignSystem() },
        agentAvailable,
      }}
    >
      <EditorShell />
    </EditorProvider>,
  );
  return { commits, server: () => doc, doc: () => doc };
}

const key = (k: string, opts: KeyboardEventInit = {}) =>
  act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));
  });

const frameText = () =>
  [...document.querySelectorAll('[data-cd-frame-host]')]
    .map((h) => h.shadowRoot?.textContent ?? '')
    .join(' ');

describe('EditorShell', () => {
  it('editors can insert the sample design, undo, redo, and it saves', async () => {
    const { commits, server } = setup('editor');
    await act(async () => {});
    fireEvent.click(screen.getByRole('radio', { name: 'Edit' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Insert a sample design' }));
    await act(async () => {});
    expect(frameText()).toContain('Ship designs your engineers can build.');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();

    await key('z', { metaKey: true });
    expect(frameText()).not.toContain('Ship designs');
    await key('z', { metaKey: true, shiftKey: true });
    expect(frameText()).toContain('Ship designs');

    // Flush happens on the debounce; force it by hiding the tab.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(commits.length).toBe(1);
    expect(Object.keys(server().nodes).length).toBeGreaterThan(10);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('viewers see a read-only editor', async () => {
    setup('viewer');
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Insert a sample design' })).toBeNull();
    expect(screen.getByText('View only')).toBeTruthy();
    // Viewers can only view: no Edit mode, and no Comment mode without comment or agent access.
    expect(screen.queryByRole('radio', { name: 'Edit' })).toBeNull();
    await key('e');
    expect(screen.getByRole('radio', { name: 'View' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/You have view access/)).toBeTruthy();
  });

  it('archived projects open read-only, even for editors', async () => {
    setup('editor', true);
    await act(async () => {});
    expect(screen.getByText('Archived')).toBeTruthy();
    expect(screen.queryByText('View only')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Insert a sample design' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Edit' })).toBeNull();
    expect(screen.getByText(/This project is archived/)).toBeTruthy();
    // Deterministic export stays available.
    expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy();
  });

  it('E and C switch modes; Edit mode swaps the chat for the edit panel', async () => {
    setup('editor');
    await act(async () => {});
    const checked = () =>
      screen.getAllByRole('radio').find((r) => r.getAttribute('aria-checked') === 'true')
        ?.textContent;
    expect(checked()).toBe('View');
    expect(screen.getByText('Agent')).toBeTruthy();
    await key('e');
    expect(checked()).toBe('Edit');
    expect(screen.queryByText('Agent')).toBeNull();
    await key('e');
    expect(checked()).toBe('View');
    await key('c');
    expect(checked()).toBe('Comment');
    expect(screen.getByTestId('comment-mode-layer')).toBeTruthy();
    await key('Escape');
    expect(checked()).toBe('View');
    expect(screen.queryByTestId('comment-mode-layer')).toBeNull();
  });

  it('the comments pane opens over the chat pane', async () => {
    setup('editor');
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /^Comments/ }));
    const pane = screen.getByRole('dialog', { name: 'Comments' });
    expect(pane.closest('aside')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close comments' }));
    expect(screen.queryByRole('dialog', { name: 'Comments' })).toBeNull();
  });

  it('comment mode: Send to agent posts into the open chat with the element as context', async () => {
    const { doc } = setup('editor', false, true);
    await act(async () => {});
    const frame = doc().frames[0]!;
    hit.target = { frameId: frame.id, nodeId: frame.rootNodeId };
    await key('c');
    fireEvent.pointerDown(screen.getByTestId('comment-mode-layer'), { button: 0 });
    const popover = await screen.findByRole('dialog', { name: 'Comment on element' });
    fireEvent.change(popover.querySelector('textarea')!, {
      target: { value: 'Make this warmer' },
    });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByRole('dialog', { name: 'Comment on element' })).toBeNull();
    const sent = fetchMock.mock.calls
      .map(([, init]) => (typeof init?.body === 'string' ? init.body : ''))
      .find((b) => b.includes('Make this warmer'));
    expect(sent).toBeTruthy();
    const body = JSON.parse(sent!) as { prompt: string; selection?: string[]; frameId?: string };
    expect(body.prompt).toMatch(/^On .+:\nMake this warmer$/);
    expect(body.selection).toEqual([frame.rootNodeId]);
    expect(body.frameId).toBe(frame.id);
    hit.target = null;
  });
});
