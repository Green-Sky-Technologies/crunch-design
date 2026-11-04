// @vitest-environment happy-dom
import { permissionsFor, type Role } from '@crunch/authz';
import {
  sampleLandingDoc,
  starterDesignSystem,
  type DesignDoc,
  type Slider,
} from '@crunch/doc-model';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createDocStore, EditorProvider, type DocApi } from '../doc-store';
import { finishDrag, SliderTray } from './slider-tray';
import { sliderOps } from '@crunch/agent/sliders';

afterEach(cleanup);

const density: Slider = {
  id: 's_density001',
  label: 'Density',
  min: 0,
  max: 10,
  step: 1,
  value: 5,
  pinned: false,
  createdBy: 'agent',
  bindings: [
    {
      target: { nodeId: 'n_features01', prop: 'gap', breakpoint: 'base' },
      map: { type: 'linear', from: 0, to: 40, unit: 'px' },
    },
  ],
};
const docWithSlider = (): DesignDoc => ({ ...sampleLandingDoc(), sliders: [density] });
const api: DocApi = {
  fetchDoc: async () => ({ version: 0, doc: docWithSlider() }),
  commit: async () => ({ ok: true, version: 1 }),
  since: async () => ({ version: 0, txns: [], reset: false }),
};

describe('finishDrag', () => {
  it('collapses a drag with long pauses into one undo step', () => {
    let t = 0;
    const store = createDocStore({
      projectId: 'p',
      version: 0,
      doc: docWithSlider(),
      readOnly: false,
      api,
      debounceMs: 1e9,
      now: () => t,
    });
    const depth = store.getState().undoStack.length;
    for (const v of [6, 7, 8]) {
      const s = store.getState().doc.sliders[0]!;
      store.getState().apply(sliderOps(store.getState().doc, s, v), {
        source: 'slider',
        coalesceKey: 'slider:x:1',
      });
      t += 5000; // pause longer than the coalesce window
    }
    expect(store.getState().undoStack.length - depth).toBe(3);
    finishDrag(store, depth, store.getState().doc.sliders[0]!, 8, 'Adjust Density');
    expect(store.getState().undoStack.length - depth).toBe(1);
    expect(store.getState().doc.nodes['n_features01']!.style.base?.gap).toBe(32);
    store.getState().undo();
    expect(store.getState().doc.sliders[0]!.value).toBe(5);
    expect(store.getState().doc.nodes['n_features01']!.style.base?.gap).toEqual({
      token: 'space.4',
    });
  });
});

function renderTray(role: Role) {
  const doc = docWithSlider();
  render(
    <EditorProvider
      api={api}
      pollMs={1e9}
      initial={{ version: 0, doc }}
      info={{
        project: { id: 'p', name: 'P', description: null },
        workspace: { id: 'w', slug: 'w', name: 'W' },
        user: { id: 'u', role },
        permissions: permissionsFor(role),
        designSystem: { id: 'd', name: 'S', version: null, spec: starterDesignSystem() },
        agentAvailable: false,
      }}
    >
      <SliderTray />
    </EditorProvider>,
  );
}

describe('SliderTray', () => {
  it('drags, pins, renames and deletes sliders for editors', () => {
    renderTray('editor');
    const range = screen.getByLabelText('Density') as HTMLInputElement;
    fireEvent.pointerDown(range);
    fireEvent.change(range, { target: { value: '9' } });
    fireEvent.pointerUp(range);
    expect(screen.getByText('9')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Pin slider'));
    expect(screen.getByLabelText('Unpin slider')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Rename slider'));
    const name = screen.getByLabelText('Slider name');
    fireEvent.change(name, { target: { value: 'Spacing' } });
    fireEvent.blur(name);
    expect(screen.getByLabelText('Spacing')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Delete slider'));
    expect(screen.queryByLabelText('Spacing')).toBeNull();
  });

  it('is read-only for viewers', () => {
    renderTray('viewer');
    expect((screen.getByLabelText('Density') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByLabelText('Delete slider')).toBeNull();
  });
});
