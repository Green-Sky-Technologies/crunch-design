/**
 * CrunchDesign Figma plugin, main thread. All writes into Figma happen here (Figma's REST API
 * can't create nodes; SPEC D12). This file is a thin adapter: the UI fetches plans from the
 * CrunchDesign API and the main thread applies them. Mapping logic lives in
 * @crunch/figma-convert as pure, tested functions.
 */
import { applyPushPlan } from './main/push';
import { collector } from './main/note';
import { readVariablesSnapshot } from './main/read-variables';
import { serializeSelection } from './main/selection';
import { upsertVariables } from './main/variables';
import type { FileInfo, Settings, ToMain, ToUi } from './shared/messages';

const SETTINGS_KEY = 'crunchdesign.settings.v1';
const FILE_ID_KEY = 'cd:file';

figma.showUI(__html__, { width: 380, height: 600, themeColors: true });

function post(msg: ToUi) {
  figma.ui.postMessage(msg);
}

function isSettings(v: unknown): v is Settings {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Settings).apiBase === 'string' &&
    typeof (v as Settings).token === 'string'
  );
}

function uuid(): string {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) s += '-';
    else if (i === 14) s += '4';
    else s += hex[Math.floor(Math.random() * 16)];
  }
  return s;
}

/**
 * `figma.fileKey` is only exposed to private/development plugins. Otherwise we keep a stable
 * random id in the document's plugin data, so links and token sync still key on "this file".
 */
function fileInfo(): FileInfo {
  let key = figma.fileKey ?? '';
  if (!key) {
    key = figma.root.getPluginData(FILE_ID_KEY);
    if (!key) {
      key = `local:${uuid()}`;
      figma.root.setPluginData(FILE_ID_KEY, key);
    }
  }
  return { fileKey: key, fileName: figma.root.name, pageId: figma.currentPage.id };
}

async function sendSettings() {
  const stored: unknown = await figma.clientStorage.getAsync(SETTINGS_KEY);
  post({ type: 'settings', settings: isSettings(stored) ? stored : null, file: fileInfo() });
}

async function handle(msg: ToMain) {
  switch (msg.type) {
    case 'load-settings':
      return sendSettings();
    case 'save-settings':
      if (!isSettings(msg.settings)) throw new Error('Invalid settings');
      await figma.clientStorage.setAsync(SETTINGS_KEY, {
        apiBase: msg.settings.apiBase.slice(0, 200),
        token: msg.settings.token.slice(0, 100),
      });
      return sendSettings();
    case 'clear-settings':
      await figma.clientStorage.deleteAsync(SETTINGS_KEY);
      return sendSettings();
    case 'notify':
      figma.notify(String(msg.message).slice(0, 200), { error: !!msg.error });
      return;
    case 'resize':
      figma.ui.resize(380, Math.max(320, Math.min(900, Math.round(msg.height))));
      return;
    case 'push': {
      if (msg.plan?.version !== 1) throw new Error('Unsupported push plan version');
      const out = await applyPushPlan(msg.plan, (m) => post({ type: 'progress', message: m }));
      post({ type: 'push-done', result: { ...out, file: { ...fileInfo(), pageId: out.pageId } } });
      figma.notify(
        `Pushed: ${out.created} created, ${out.updated} updated, ${out.removed} removed`,
      );
      return;
    }
    case 'read-selection': {
      post({ type: 'progress', message: 'Reading selection…' });
      const payload = await serializeSelection();
      post({ type: 'selection', payload, file: fileInfo() });
      return;
    }
    case 'read-variables':
      post({ type: 'variables', snapshot: await readVariablesSnapshot(), file: fileInfo() });
      return;
    case 'apply-variables': {
      const { items, note } = collector();
      const remove = (msg.remove ?? []).slice(0, 5000);
      const r = await upsertVariables(msg.variables, note, { remove });
      post({
        type: 'variables-applied',
        snapshot: await readVariablesSnapshot(),
        report: items,
        created: r.created,
        updated: r.updated,
        removed: remove.length,
      });
      figma.notify(
        `Variables: ${r.created} created, ${r.updated} updated, ${remove.length} removed`,
      );
      return;
    }
    case 'close':
      figma.closePlugin();
      return;
  }
}

figma.ui.onmessage = (msg: ToMain) => {
  handle(msg).catch((e: unknown) => {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  });
};
