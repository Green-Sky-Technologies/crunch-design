/**
 * Tokens tab (Story 8.4): compare the project's design system with this file's variables, review
 * the diff, and apply selected changes in either direction. Conflicts need an explicit choice.
 */
import type {
  ReportItem,
  Resolution,
  TokenDiff,
  TokenDiffEntry,
  VariablesSnapshot,
  VariablesSpec,
} from '@crunch/figma-convert/plugin';
import type { FileInfo } from '../shared/messages';
import { h } from './dom';
import { callMain, registerTab, render, state, task } from './main';
import { reportView } from './report';

interface DiffResponse extends TokenDiff {
  designSystem: { id: string; name: string };
  report: ReportItem[];
}

const sync = {
  projectId: '',
  direction: 'pull' as 'pull' | 'push',
  snapshot: null as VariablesSnapshot | null,
  file: null as FileInfo | null,
  diff: null as DiffResponse | null,
  selected: new Set<string>(),
  resolutions: {} as Record<string, Resolution>,
  result: null as string | null,
  report: [] as ReportItem[],
};

const fmt = (v: unknown): string =>
  v === undefined
    ? '—'
    : typeof v === 'object' && v !== null && 'ref' in v
      ? `→ ${(v as { ref: string }).ref}`
      : String(v);

async function compare() {
  const api = state.api;
  const projectId = sync.projectId || state.projectId;
  if (!api || !projectId) return;
  const { snapshot, file } = await callMain({ type: 'read-variables' }, 'variables');
  sync.snapshot = snapshot;
  sync.file = file;
  sync.result = null;
  sync.diff = await api.variables<DiffResponse>(projectId, 'diff', {
    fileKey: file.fileKey,
    direction: sync.direction,
    snapshot,
  });
  sync.report = sync.diff.report;
  // Defaults: apply additions and safe changes; removals and conflicts are opt-in.
  sync.selected = new Set(
    sync.diff.entries
      .filter((e) => e.status === 'added' || e.status === 'changed')
      .map((e) => e.key),
  );
  sync.resolutions = {};
}

async function apply() {
  const api = state.api;
  const projectId = sync.projectId || state.projectId;
  if (!api || !projectId || !sync.snapshot || !sync.file || !sync.diff) return;
  const body = {
    fileKey: sync.file.fileKey,
    direction: sync.direction,
    snapshot: sync.snapshot,
    selected: [...sync.selected],
    resolutions: sync.resolutions,
  };
  if (sync.direction === 'pull') {
    const r = await api.variables<{ applied: boolean; message: string }>(projectId, 'pull', body);
    sync.result = r.message;
  } else {
    const plan = await api.variables<{ variables: VariablesSpec; remove: string[] }>(
      projectId,
      'push-plan',
      body,
    );
    const res = await callMain(
      { type: 'apply-variables', variables: plan.variables, remove: plan.remove },
      'variables-applied',
    );
    await api.variables(projectId, 'push-result', {
      fileKey: sync.file.fileKey,
      snapshot: res.snapshot,
    });
    sync.result = `Figma variables updated: ${res.created} created, ${res.updated} updated, ${res.removed} removed.`;
    sync.report = res.report;
  }
  sync.diff = null;
}

function entryRow(e: TokenDiffEntry): HTMLElement {
  const box = h('input', {
    type: 'checkbox',
    checked: sync.selected.has(e.key),
    onchange: ((ev: Event) => {
      if ((ev.target as HTMLInputElement).checked) sync.selected.add(e.key);
      else sync.selected.delete(e.key);
      render();
    }) as EventListener,
  });
  const choice =
    e.status === 'conflict'
      ? h(
          'select',
          {
            onchange: ((ev: Event) => {
              const v = (ev.target as HTMLSelectElement).value as Resolution | '';
              if (v) sync.resolutions[e.key] = v;
              else delete sync.resolutions[e.key];
              render();
            }) as EventListener,
          },
          h('option', { value: '' }, 'Choose…'),
          h(
            'option',
            { value: 'ours', ...(sync.resolutions[e.key] === 'ours' ? { selected: true } : {}) },
            'Keep CrunchDesign',
          ),
          h(
            'option',
            {
              value: 'theirs',
              ...(sync.resolutions[e.key] === 'theirs' ? { selected: true } : {}),
            },
            'Keep Figma',
          ),
        )
      : null;
  return h(
    'li',
    { class: 'row' },
    box,
    h(
      'div',
      { class: 'grow' },
      h('code', {}, e.path),
      e.theme ? h('span', { class: 'muted small' }, ` (${e.theme})`) : null,
      h(
        'div',
        { class: `small diff-${e.status}` },
        `${e.status} · CD ${fmt(e.ours)} · Figma ${fmt(e.theirs)}`,
      ),
      e.reason ? h('div', { class: 'small muted' }, e.reason) : null,
    ),
    choice,
  );
}

function view(): HTMLElement {
  if (state.me?.role === 'viewer') return h('p', { class: 'muted' }, 'Viewers can’t sync tokens.');
  const current = sync.projectId || state.projectId || '';
  const d = sync.diff;
  const unresolved = d
    ? d.entries.filter(
        (e) => e.status === 'conflict' && sync.selected.has(e.key) && !sync.resolutions[e.key],
      ).length
    : 0;
  return h(
    'div',
    { class: 'stack' },
    h('label', {}, 'Project (uses its design system)'),
    h(
      'select',
      {
        onchange: ((e: Event) => {
          sync.projectId = (e.target as HTMLSelectElement).value;
          sync.diff = null;
          render();
        }) as EventListener,
      },
      h('option', { value: '' }, 'Choose a project…'),
      state.projects.map((p) =>
        h('option', { value: p.id, ...(p.id === current ? { selected: true } : {}) }, p.name),
      ),
    ),
    h('label', {}, 'Direction'),
    h(
      'select',
      {
        onchange: ((e: Event) => {
          sync.direction = (e.target as HTMLSelectElement).value as 'pull' | 'push';
          sync.diff = null;
          render();
        }) as EventListener,
      },
      h(
        'option',
        { value: 'pull', ...(sync.direction === 'pull' ? { selected: true } : {}) },
        'Pull: Figma variables → design system draft',
      ),
      h(
        'option',
        { value: 'push', ...(sync.direction === 'push' ? { selected: true } : {}) },
        'Push: design system tokens → Figma variables',
      ),
    ),
    h(
      'button',
      {
        disabled: !current || !!state.busy,
        onclick: (() => void task('Comparing…', compare)) as EventListener,
      },
      'Compare',
    ),
    d
      ? h(
          'div',
          { class: 'stack' },
          h(
            'p',
            { class: 'small' },
            `${d.designSystem.name} ⇄ ${d.collection?.name ?? 'no collection yet'}: ${d.summary.added} added, ${d.summary.changed} changed, ${d.summary.removed} removed, ${d.summary.conflict} conflicts${d.hasBase ? '' : ' (first sync: differing values are conflicts)'}.`,
          ),
          d.entries.length
            ? h('ul', { class: 'list' }, d.entries.map(entryRow))
            : h('p', { class: 'muted' }, 'Already in sync.'),
          unresolved
            ? h(
                'p',
                { class: 'status error' },
                `Choose a side for ${unresolved} selected conflict(s).`,
              )
            : null,
          h(
            'button',
            {
              class: 'primary',
              disabled: !sync.selected.size || unresolved > 0 || !!state.busy,
              onclick: (() => void task('Applying…', apply)) as EventListener,
            },
            `Apply ${sync.selected.size} change${sync.selected.size === 1 ? '' : 's'} ${sync.direction === 'pull' ? 'to the design system' : 'to Figma'}`,
          ),
        )
      : null,
    sync.result ? h('p', {}, sync.result) : null,
    sync.report.length ? reportView(sync.report, 'Notes') : null,
  );
}

registerTab({ id: 'tokens', label: 'Tokens', render: view });
