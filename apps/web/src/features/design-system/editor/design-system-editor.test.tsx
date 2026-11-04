// @vitest-environment happy-dom
import { starterDesignSystem, type DesignSystemSpec } from '@crunch/doc-model';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemEditor } from './design-system-editor';

const saved: DesignSystemSpec[] = [];
vi.mock('@/server/actions/design-systems', () => ({
  saveDesignSystemDraftAction: vi.fn(async (_id: string, spec: DesignSystemSpec) => {
    saved.push(spec);
    return { ok: true, data: { revision: String(saved.length), spec } };
  }),
  updateDesignSystemDetailsAction: vi.fn(async () => ({ ok: true, data: undefined })),
  publishDesignSystemAction: vi.fn(async () => ({ ok: true, data: { version: 1, revision: 'p' } })),
  getDesignSystemVersionSpecAction: vi.fn(),
  upgradeProjectDesignSystemAction: vi.fn(),
  discardDesignSystemDraftAction: vi.fn(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

afterEach(cleanup);

const system = {
  id: 'ds1',
  name: 'Brand',
  description: null,
  isDefault: true,
  latestVersion: null,
  hasUnpublishedChanges: true,
  revision: '0',
};

function previewCss(): string {
  const host = document.querySelector('[aria-label="Live preview"] [data-cd-frame-host]')!;
  return [...(host.shadowRoot?.querySelectorAll('style') ?? [])].map((s) => s.textContent).join('');
}

describe('DesignSystemEditor', () => {
  it('edits a token, updates the live preview, and saves a valid draft', async () => {
    render(
      <DesignSystemEditor
        workspaceSlug="ws"
        system={system}
        initialDraft={starterDesignSystem()}
        canEdit
      />,
    );
    await act(async () => {});
    expect(previewCss()).toContain('--color-primary:#4f46e5');

    const input = screen.getByLabelText('color.primary value');
    fireEvent.change(input, { target: { value: '#ff0000' } });
    await act(async () => {});
    expect(previewCss()).toContain('--color-primary:#ff0000');

    // invalid input blocks saving and keeps the last valid preview
    fireEvent.change(input, { target: { value: 'nope' } });
    expect(screen.getByRole('button', { name: 'Save draft' })).toHaveProperty('disabled', true);
    expect(screen.getAllByText(/Invalid color value/).length).toBeGreaterThan(0);
    expect(previewCss()).toContain('--color-primary:#ff0000');

    fireEvent.change(input, { target: { value: '#00ff00' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    });
    expect(saved.at(-1)!.tokens['color.primary']!.value).toBe('#00ff00');
  });

  it('adds tokens and is read-only for viewers', async () => {
    const { unmount } = render(
      <DesignSystemEditor
        workspaceSlug="ws"
        system={system}
        initialDraft={starterDesignSystem()}
        canEdit
      />,
    );
    fireEvent.change(screen.getByLabelText('New token path'), { target: { value: 'space.5' } });
    fireEvent.change(screen.getByLabelText('New token type'), { target: { value: 'dimension' } });
    fireEvent.change(screen.getByLabelText('New token value'), { target: { value: '1.25rem' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByLabelText('space.5 value')).toHaveProperty('value', '1.25rem');
    unmount();

    render(
      <DesignSystemEditor
        workspaceSlug="ws"
        system={system}
        initialDraft={starterDesignSystem()}
        canEdit={false}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.queryByLabelText('New token path')).toBeNull();
  });

  it('publishes the saved draft with notes, but not while there are unsaved edits', async () => {
    const { publishDesignSystemAction } = await import('@/server/actions/design-systems');
    render(
      <DesignSystemEditor
        workspaceSlug="ws"
        system={system}
        initialDraft={starterDesignSystem()}
        canEdit
      />,
    );
    const publish = screen.getByRole('button', { name: 'Publish…' });
    fireEvent.change(screen.getByLabelText('color.text value'), { target: { value: '#000000' } });
    expect(publish).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    expect(publish).toHaveProperty('disabled', false);

    fireEvent.click(publish);
    fireEvent.change(screen.getByLabelText('Release notes'), { target: { value: 'First cut' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    });
    expect(publishDesignSystemAction).toHaveBeenCalledWith('ds1', 'First cut', '0');
    expect(screen.getByText(/Published v1/)).toBeTruthy();
  });
});
