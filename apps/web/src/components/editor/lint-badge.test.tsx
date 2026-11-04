// @vitest-environment happy-dom
import { permissionsFor } from '@crunch/authz';
import { applyOps, initialDoc, starterDesignSystem, type DesignDoc } from '@crunch/doc-model';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EditorProvider, type DocApi } from '@/features/doc-store';
import { LintBadge } from './lint-badge';

afterEach(cleanup);

function docWithLiteralPrimary(): DesignDoc {
  const doc = initialDoc();
  const root = doc.frames[0]!.rootNodeId;
  return applyOps(doc, [
    {
      op: 'insertSubtree',
      parentId: root,
      index: 0,
      nodes: [
        {
          id: 'n_literal0001',
          type: 'text',
          tag: 'p',
          parentId: root,
          children: [],
          positioning: 'flow',
          style: { base: { color: '#4f46e5' } }, // equals color.primary: should be the token
          props: { text: 'Hi' },
        },
      ],
    },
  ]).doc;
}

const api: DocApi = {
  fetchDoc: async () => ({ version: 0, doc: initialDoc() }),
  commit: async () => ({ ok: true, version: 1 }),
  since: async () => ({ version: 0, txns: [], reset: false }),
};

function mount(doc: DesignDoc) {
  return render(
    <EditorProvider
      api={api}
      pollMs={1_000_000}
      initial={{ version: 0, doc }}
      info={{
        project: { id: '00000000-0000-4000-8000-000000000001', name: 'P', description: null },
        workspace: { id: 'w', slug: 'acme', name: 'Acme' },
        user: { id: 'u', role: 'editor' },
        permissions: permissionsFor('editor'),
        designSystem: { id: 'd', name: 'Starter', version: 1, spec: starterDesignSystem() },
        agentAvailable: false,
      }}
    >
      <LintBadge />
    </EditorProvider>,
  );
}

describe('LintBadge', () => {
  it('shows design-system issues for the live doc and lists them', async () => {
    mount(docWithLiteralPrimary());
    await act(async () => {});
    const badge = screen.getByRole('button', { name: /issue/ });
    fireEvent.click(badge);
    expect(screen.getByRole('button', { name: /token/i })).toBeTruthy();
  });

  it('renders nothing for a clean doc', async () => {
    mount(initialDoc());
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /issue/ })).toBeNull();
  });
});
