/**
 * Plugin UI (iframe). Connect with a plugin token, then browse the workspace's projects and
 * frames. Later stories add push, import and token-sync tabs on top of the same state.
 */
import {
  DEFAULT_API_BASE,
  type FileInfo,
  type Settings,
  type ToMain,
  type ToUi,
} from '../shared/messages';
import { Api, ApiError, normalizeBase, type FrameInfo, type Me, type Project } from './api';
import { h, mount } from './dom';

export interface AppState {
  settings: Settings | null;
  file: FileInfo | null;
  api: Api | null;
  me: Me | null;
  projects: Project[];
  projectId: string | null;
  frames: FrameInfo[];
  selectedFrames: Set<string>;
  tab: string;
  busy: string | null;
  error: string | null;
}

export const state: AppState = {
  settings: null,
  file: null,
  api: null,
  me: null,
  projects: [],
  projectId: null,
  frames: [],
  selectedFrames: new Set(),
  tab: 'projects',
  busy: null,
  error: null,
};

export function toMain(msg: ToMain) {
  parent.postMessage({ pluginMessage: msg }, '*');
}

const root = document.getElementById('app')!;

export interface Tab {
  id: string;
  label: string;
  render: () => HTMLElement;
}
const tabs: Tab[] = [];
export function registerTab(tab: Tab) {
  tabs.push(tab);
}

/** Main-thread message handlers registered by tabs. */
const handlers: ((msg: ToUi) => void)[] = [];
export function onMain(fn: (msg: ToUi) => void) {
  handlers.push(fn);
}

/** Send a request to the main thread and wait for a reply of `replyType` (or an error). */
export function callMain<T extends ToUi['type']>(
  msg: ToMain,
  replyType: T,
): Promise<Extract<ToUi, { type: T }>> {
  return new Promise((resolve, reject) => {
    pending = { replyType, resolve: resolve as (m: ToUi) => void, reject };
    toMain(msg);
  });
}
let pending: {
  replyType: string;
  resolve: (m: ToUi) => void;
  reject: (e: Error) => void;
} | null = null;

export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401)
      return 'Token rejected. Create a new one in CrunchDesign → Settings → Figma.';
    if (e.status === 403) return "Your role doesn't allow this.";
    if (e.status === 429) return 'Rate limited; wait a minute and retry.';
    return e.message;
  }
  if (e instanceof TypeError) return 'Could not reach CrunchDesign. Check the API URL.';
  return e instanceof Error ? e.message : String(e);
}

/** Run an async action with a busy indicator and error capture. */
export async function task(label: string, fn: () => Promise<void>) {
  state.busy = label;
  state.error = null;
  render();
  try {
    await fn();
  } catch (e) {
    state.error = errorText(e);
    if (e instanceof ApiError && e.status === 401) state.me = null;
  } finally {
    state.busy = null;
    render();
  }
}

async function connect(settings: Settings) {
  const api = new Api(settings);
  const me = await api.me();
  state.api = api;
  state.me = me;
  state.settings = settings;
  const { projects } = await api.projects();
  state.projects = projects;
}

export async function loadFrames(projectId: string) {
  if (!state.api) return;
  state.projectId = projectId;
  state.frames = [];
  state.selectedFrames = new Set();
  const res = await state.api.frames(projectId);
  state.frames = res.frames;
}

function connectView(): HTMLElement {
  const base = h('input', {
    class: 'input',
    id: 'api-base',
    value: state.settings?.apiBase ?? DEFAULT_API_BASE,
    placeholder: DEFAULT_API_BASE,
  });
  const token = h('input', {
    class: 'input',
    id: 'token',
    type: 'password',
    placeholder: 'cdp_…',
    value: state.settings?.token ?? '',
    autocomplete: 'off',
  });
  return h(
    'form',
    {
      class: 'stack',
      onsubmit: ((e: Event) => {
        e.preventDefault();
        void task('Connecting…', async () => {
          const settings = { apiBase: normalizeBase(base.value), token: token.value.trim() };
          await connect(settings);
          toMain({ type: 'save-settings', settings });
        });
      }) as EventListener,
    },
    h(
      'p',
      { class: 'muted' },
      'Create a plugin token in CrunchDesign → Settings → Figma, then paste it here.',
    ),
    h('label', { for: 'api-base' }, 'CrunchDesign URL'),
    base,
    h('label', { for: 'token' }, 'Plugin token'),
    token,
    h('button', { class: 'primary', type: 'submit', disabled: !!state.busy }, 'Connect'),
  );
}

function projectsView(): HTMLElement {
  const list = h(
    'ul',
    { class: 'list' },
    state.projects.map((p) =>
      h(
        'li',
        {
          class: p.id === state.projectId ? 'row selected' : 'row',
          onclick: (() => void task('Loading frames…', () => loadFrames(p.id))) as EventListener,
        },
        h('span', { class: 'grow' }, p.name),
        h('span', { class: 'muted small' }, new Date(p.updatedAt).toLocaleDateString()),
      ),
    ),
  );
  return h(
    'div',
    { class: 'stack' },
    h('h3', {}, 'Projects'),
    state.projects.length ? list : h('p', { class: 'muted' }, 'No projects in this workspace yet.'),
    state.projectId ? framesView() : null,
  );
}

export function framesView(): HTMLElement {
  return h(
    'div',
    { class: 'stack' },
    h('h3', {}, 'Frames'),
    state.frames.length
      ? h(
          'ul',
          { class: 'list' },
          state.frames.map((f) => {
            const box = h('input', {
              type: 'checkbox',
              checked: state.selectedFrames.has(f.id),
              onchange: ((e: Event) => {
                const on = (e.target as HTMLInputElement).checked;
                if (on) state.selectedFrames.add(f.id);
                else state.selectedFrames.delete(f.id);
                render();
              }) as EventListener,
            });
            return h(
              'li',
              { class: 'row' },
              h('label', { class: 'grow row-label' }, box, f.name),
              h(
                'span',
                { class: 'muted small' },
                `${f.width}×${f.height === 'auto' ? 'auto' : f.height} · ${f.nodeCount} nodes`,
              ),
            );
          }),
        )
      : h('p', { class: 'muted' }, 'This project has no frames.'),
  );
}

registerTab({ id: 'projects', label: 'Projects', render: projectsView });

export function render() {
  const header = h(
    'header',
    { class: 'header' },
    h('strong', {}, 'CrunchDesign'),
    state.me
      ? h(
          'span',
          { class: 'muted small grow right' },
          `${state.me.workspace.name} · ${state.me.role}`,
          ' ',
          h(
            'button',
            {
              class: 'link',
              onclick: (() => {
                state.me = null;
                state.api = null;
                toMain({ type: 'clear-settings' });
                render();
              }) as EventListener,
            },
            'Disconnect',
          ),
        )
      : null,
  );
  const status = state.busy
    ? h('p', { class: 'status' }, state.busy)
    : state.error
      ? h('p', { class: 'status error' }, state.error)
      : null;

  if (!state.me) return mount(root, header, status, connectView());

  const nav = h(
    'nav',
    { class: 'tabs' },
    tabs.map((t) =>
      h(
        'button',
        {
          class: t.id === state.tab ? 'tab active' : 'tab',
          onclick: (() => {
            state.tab = t.id;
            state.error = null;
            render();
          }) as EventListener,
        },
        t.label,
      ),
    ),
  );
  const current = tabs.find((t) => t.id === state.tab) ?? tabs[0]!;
  mount(root, header, nav, status, current.render());
}

window.onmessage = (event: MessageEvent) => {
  const msg = (event.data as { pluginMessage?: ToUi } | null)?.pluginMessage;
  if (!msg) return;
  if (pending && (msg.type === pending.replyType || msg.type === 'error')) {
    const p = pending;
    pending = null;
    if (msg.type === 'error') p.reject(new Error(msg.message));
    else p.resolve(msg);
    return;
  }
  if (msg.type === 'error') {
    state.error = msg.message;
    state.busy = null;
    render();
  } else if (msg.type === 'settings') {
    state.file = msg.file;
    const firstLoad = state.settings === null && msg.settings !== null && !state.me;
    state.settings = msg.settings;
    if (firstLoad && msg.settings) {
      const s = msg.settings;
      void task('Connecting…', () => connect(s));
    } else render();
  } else if (msg.type === 'progress') {
    state.busy = msg.message;
    render();
  }
  for (const fn of handlers) fn(msg);
};

export function start() {
  render();
  toMain({ type: 'load-settings' });
}
