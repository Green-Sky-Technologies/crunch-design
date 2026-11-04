/** Push tab (Story 8.2): pick frames and a width, push, then show the mapping report. */
import type { ReportItem } from '@crunch/figma-convert/plugin';
import { h } from './dom';
import { callMain, framesView, loadFrames, registerTab, render, state, task } from './main';
import { reportView } from './report';

const WIDTHS = [
  { label: 'Frame width', value: 0 },
  { label: 'Desktop 1440', value: 1440 },
  { label: 'Desktop 1280', value: 1280 },
  { label: 'Tablet 768', value: 768 },
  { label: 'Mobile 375', value: 375 },
];

const push = {
  width: 0,
  variables: true,
  last: null as null | {
    report: ReportItem[];
    created: number;
    updated: number;
    unchanged: number;
    removed: number;
  },
};

async function run() {
  const api = state.api;
  const projectId = state.projectId;
  if (!api || !projectId) return;
  const frameIds = state.selectedFrames.size ? [...state.selectedFrames] : undefined;
  const plan = await api.pushPlan(projectId, {
    frameIds,
    width: push.width || undefined,
    variables: push.variables,
  });
  const { result } = await callMain({ type: 'push', plan }, 'push-done');
  state.busy = 'Saving push…';
  render();
  await api.pushResult(projectId, {
    fileKey: result.file.fileKey,
    fileName: result.file.fileName,
    pageId: result.file.pageId,
    docVersion: plan.docVersion,
    nodeMap: result.nodeMap,
    report: result.report.slice(0, 1000),
  });
  push.last = result;
}

function view(): HTMLElement {
  if (state.me?.role === 'viewer') {
    return h(
      'p',
      { class: 'muted' },
      'Viewers can browse but not push. Ask an Admin for Editor access.',
    );
  }
  const projectSelect = h(
    'select',
    {
      onchange: ((e: Event) => {
        const id = (e.target as HTMLSelectElement).value;
        void task('Loading frames…', () => loadFrames(id));
      }) as EventListener,
    },
    h('option', { value: '' }, 'Choose a project…'),
    state.projects.map((p) =>
      h('option', { value: p.id, ...(p.id === state.projectId ? { selected: true } : {}) }, p.name),
    ),
  );
  const widthSelect = h(
    'select',
    {
      onchange: ((e: Event) => {
        push.width = Number((e.target as HTMLSelectElement).value);
      }) as EventListener,
    },
    WIDTHS.map((w) =>
      h(
        'option',
        { value: String(w.value), ...(w.value === push.width ? { selected: true } : {}) },
        w.label,
      ),
    ),
  );
  const vars = h('input', {
    type: 'checkbox',
    checked: push.variables,
    onchange: ((e: Event) => {
      push.variables = (e.target as HTMLInputElement).checked;
    }) as EventListener,
  });
  const n = state.selectedFrames.size;
  return h(
    'div',
    { class: 'stack' },
    h('label', {}, 'Project'),
    projectSelect,
    state.projectId ? framesView() : null,
    h('label', {}, 'Width (picks the breakpoint)'),
    widthSelect,
    h(
      'label',
      { class: 'row-label' },
      vars,
      'Bind to Figma variables (creates missing ones; never changes existing values; use the Tokens tab to sync values)',
    ),
    h(
      'button',
      {
        class: 'primary',
        disabled: !state.projectId || !!state.busy,
        onclick: (() => void task('Building push plan…', run)) as EventListener,
      },
      n ? `Push ${n} frame${n === 1 ? '' : 's'}` : 'Push all frames',
    ),
    h(
      'p',
      { class: 'muted small' },
      'Pushing again updates the same Figma layers in place and only adds or removes what changed. Layers you add by hand are kept.',
    ),
    push.last
      ? h(
          'div',
          { class: 'stack' },
          h(
            'p',
            {},
            `Done: ${push.last.created} created, ${push.last.updated} updated, ${push.last.unchanged} unchanged, ${push.last.removed} removed.`,
          ),
          reportView(push.last.report),
        )
      : null,
  );
}

registerTab({ id: 'push', label: 'Push', render: view });
