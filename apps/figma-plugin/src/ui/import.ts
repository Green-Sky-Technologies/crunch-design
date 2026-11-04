/** Import tab (Story 8.3): send the current Figma selection into a CrunchDesign project. */
import type { ReportItem } from '@crunch/figma-convert/plugin';
import { h } from './dom';
import { callMain, registerTab, render, state, task } from './main';
import { reportView } from './report';

const imp = {
  projectId: '' as string,
  last: null as null | { frames: string[]; report: ReportItem[]; tokens: number },
};

async function run() {
  const api = state.api;
  const projectId = imp.projectId || state.projectId;
  if (!api || !projectId) return;
  const { payload, file } = await callMain({ type: 'read-selection' }, 'selection');
  state.busy = 'Converting in CrunchDesign…';
  render();
  const res = await api.importNodes(projectId, {
    fileKey: file.fileKey,
    fileName: file.fileName,
    nodes: payload.nodes,
    svgs: payload.svgs,
    images: payload.images,
    variables: payload.variables,
  });
  const skipped: ReportItem[] = payload.skipped.map((s) => ({
    severity: 'warning',
    message: `Not exported: ${s}`,
  }));
  imp.last = {
    frames: res.frames.map((f) => f.name),
    report: [...skipped, ...res.report],
    tokens: res.stats.tokens,
  };
}

function view(): HTMLElement {
  if (state.me?.role === 'viewer') return h('p', { class: 'muted' }, 'Viewers cannot import.');
  const current = imp.projectId || state.projectId || '';
  return h(
    'div',
    { class: 'stack' },
    h(
      'p',
      { class: 'muted' },
      'Select frames in Figma, pick a project, and import. Each selected layer becomes a new frame (one-shot copy, not a live link).',
    ),
    h('label', {}, 'Into project'),
    h(
      'select',
      {
        onchange: ((e: Event) => {
          imp.projectId = (e.target as HTMLSelectElement).value;
          render();
        }) as EventListener,
      },
      h('option', { value: '' }, 'Choose a project…'),
      state.projects.map((p) =>
        h('option', { value: p.id, ...(p.id === current ? { selected: true } : {}) }, p.name),
      ),
    ),
    h(
      'button',
      {
        class: 'primary',
        disabled: !current || !!state.busy,
        onclick: (() => void task('Reading selection…', run)) as EventListener,
      },
      'Import selection',
    ),
    imp.last
      ? h(
          'div',
          { class: 'stack' },
          h('p', {}, `Imported ${imp.last.frames.join(', ')} · ${imp.last.tokens} token matches.`),
          reportView(imp.last.report, 'Fidelity report'),
        )
      : null,
  );
}

registerTab({ id: 'import', label: 'Import', render: view });
