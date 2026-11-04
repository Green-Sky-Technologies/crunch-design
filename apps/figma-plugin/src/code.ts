/**
 * CrunchDesign Figma plugin, main thread. All writes into Figma happen here (Figma's REST API
 * can't create nodes; SPEC D12). This file is a thin adapter: the UI fetches plans from the
 * CrunchDesign API and the main thread applies them. Mapping logic lives in
 * @crunch/figma-convert as pure, tested functions.
 */
import type { Settings, ToMain, ToUi } from './shared/messages';

const SETTINGS_KEY = 'crunchdesign.settings.v1';

figma.showUI(__html__, { width: 380, height: 560, themeColors: true });

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

async function sendSettings() {
  const stored: unknown = await figma.clientStorage.getAsync(SETTINGS_KEY);
  post({
    type: 'settings',
    settings: isSettings(stored) ? stored : null,
    // fileKey is only available to private/development plugins; we fall back to the file name.
    fileKey: figma.fileKey ?? null,
    fileName: figma.root.name,
  });
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
