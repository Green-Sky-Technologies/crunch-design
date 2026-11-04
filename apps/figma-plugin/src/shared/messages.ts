/**
 * Messages between the plugin UI iframe (network, rendering) and the main thread (Figma
 * document access). The UI talks to the CrunchDesign API; the main thread never does.
 */

export interface Settings {
  apiBase: string;
  token: string;
}

/** UI -> main thread. */
export type ToMain =
  | { type: 'load-settings' }
  | { type: 'save-settings'; settings: Settings }
  | { type: 'clear-settings' }
  | { type: 'notify'; message: string; error?: boolean }
  | { type: 'resize'; height: number }
  | { type: 'close' };

/** Main thread -> UI. */
export type ToUi =
  | { type: 'settings'; settings: Settings | null; fileKey: string | null; fileName: string }
  | { type: 'error'; message: string };

export const DEFAULT_API_BASE = 'http://localhost:3000';
