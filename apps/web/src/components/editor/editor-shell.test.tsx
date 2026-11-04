// @vitest-environment happy-dom
import { permissionsFor } from '@crunch/authz';
import { applyOps, initialDoc, starterDesignSystem, type DesignDoc } from '@crunch/doc-model';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorProvider, type DocApi } from '@/features/doc-store';
import { EditorShell } from './editor-shell';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

function setup(role: 'editor' | 'viewer') {
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
        project: { id: '00000000-0000-4000-8000-000000000001', name: 'Landing', description: null },
        workspace: { id: 'w', slug: 'acme', name: 'Acme' },
        user: { id: 'u', role },
        permissions: permissionsFor(role),
        designSystem: { id: 'd', name: 'Starter', version: null, spec: starterDesignSystem() },
        agentAvailable: false,
      }}
    >
      <EditorShell />
    </EditorProvider>,
  );
  return { commits, server: () => doc };
}

const frameText = () =>
  [...document.querySelectorAll('[data-cd-frame-host]')]
    .map((h) => h.shadowRoot?.textContent ?? '')
    .join(' ');

describe('EditorShell', () => {
  it('editors can insert the sample design, undo, redo, and it saves', async () => {
    const { commits, server } = setup('editor');
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Insert a sample design' }));
    await act(async () => {});
    expect(frameText()).toContain('Ship designs your engineers can build.');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await act(async () => {});
    expect(frameText()).not.toContain('Ship designs');
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    await act(async () => {});
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
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/You have view access/)).toBeTruthy();
  });
});
