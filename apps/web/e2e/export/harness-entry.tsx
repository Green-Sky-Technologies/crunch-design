/**
 * Browser harness for the visual parity test (Story 7.1 AC): renders one frame with the live
 * canvas renderer (FrameView, Shadow DOM) exactly as the canvas does. Bundled by esbuild in
 * parity.spec.ts; inputs come from window.__PARITY__.
 */
import type { DesignDoc, DesignSystemSpec } from '@crunch/doc-model';
import { FrameView } from '@crunch/renderer/react';
import { createRoot } from 'react-dom/client';

declare global {
  interface Window {
    __PARITY__: { doc: DesignDoc; ds: DesignSystemSpec; frameId: string };
    __PARITY_READY__?: boolean;
  }
}

const { doc, ds, frameId } = window.__PARITY__;
const el = document.getElementById('root')!;
createRoot(el).render(
  <FrameView
    doc={doc}
    ds={ds}
    frameId={frameId}
    options={{ annotate: false, showHidden: false }}
  />,
);
// The style registry flushes in a microtask after commit; wait two frames to be safe.
requestAnimationFrame(() => requestAnimationFrame(() => (window.__PARITY_READY__ = true)));
