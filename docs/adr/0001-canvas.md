# ADR 0001: Canvas engine (tldraw vs custom surface) and frame container (Shadow DOM vs iframe)

- **Status:** Accepted
- **Date:** 2026-11-03
- **Story:** 3.0 (spike), informs 3.1–3.10

## Context

CrunchDesign frames are live HTML rendered from the DesignDoc by `@crunch/renderer`'s
`FrameView` (SPEC D1). The canvas must:

1. Pan and zoom an infinite surface of many frames at 60fps (3.1).
2. Select _individual DOM nodes inside a frame_, with hover outlines, multi-select and tree
   navigation, and keep the overlay correct across zoom levels and breakpoints (3.2).
3. Drag nodes within the flow layout (reorder/reparent), resize them, and edit text in place
   (3.4–3.6). All of these are interactions with elements _inside_ a frame, not with the frame.
4. Route every edit through DesignDoc ops and the doc store's undo history (3.7, SPEC §2).

Two engine options and two frame-container options were compared.

## Options

- **A. tldraw (v5.6) custom shapes.** One `ShapeUtil` per frame whose `component()` returns an
  `HTMLContainer` hosting `FrameView`. tldraw owns the camera, culling, selection, and its own
  store and undo history.
- **B. Custom CSS-transform surface.** A viewport element with one "world" layer transformed by
  `translate(x, y) scale(z)`. Frames are absolutely positioned at `frame.canvas`. Selection,
  hover, and handles are drawn in a separate screen-space overlay layer computed from
  `getBoundingClientRect()` of the hit node.

Frame containers (both engines): **Shadow DOM** (what `FrameView` does today) vs **iframe**
(`srcdoc` with the static renderer's HTML).

## Method

The spike lived in `packages/canvas/spike` (deleted with this commit; the method is recorded here
so it can be rebuilt). A generator produced the 3.0 benchmark size: **20 frames of ~300 nodes**
(13 sections × [heading + 4-column grid of cards with title, body, button]); 6,129 DOM nodes in
total. Each option was bundled with esbuild (production React, minified) and driven by Playwright
1.64 against a local static server, viewport 1440×900, on an Apple M4 Pro:

- **Pan/zoom:** a 4-second scripted camera animation, one camera update per
  `requestAnimationFrame`, panning across two rows of frames while oscillating zoom between 0.25
  and 1. We report achieved fps, p95 frame interval, frames over 33ms, and `camMs`, the
  main-thread cost of one camera update including the style/layout it forces.
- **Selection latency:** five real mouse clicks on nodes at zoom 1. Time from `pointerdown` to
  the frame after the outline overlay was positioned. "Hits" counts clicks that resolved to a
  `data-cd-id` node inside the frame (through the shadow root or the iframe document).
- **Memory:** Chromium only (CDP `HeapProfiler.collectGarbage` then `Runtime.getHeapUsage`).
- **Mount:** `performance.now()` two animation frames after all frames mounted.
- A second Chromium pass applies **4× CPU throttling** to approximate a mid-range laptop.

Headless browsers cap rAF (Chromium 60Hz, WebKit 30Hz, Firefox uncapped), so fps saturates for
every option; `camMs`, mount time, and selection latency are the discriminating numbers.

## Results

| Browser         | Option          | Mount (ms) | FPS   | p95 (ms) | camMs | Select (ms, median) | Hits | JS heap (MB) |
| --------------- | --------------- | ---------- | ----- | -------- | ----- | ------------------- | ---- | ------------ |
| Chromium        | tldraw + shadow | 396        | 60    | 16.7     | 1.00  | 14                  | 5/5  | 23.1         |
| Chromium        | custom + shadow | 167        | 60.3  | 16.8     | 0.05  | 2.9                 | 5/5  | 16.5         |
| Chromium        | custom + iframe | 127        | 60.3  | 16.8     | 0.07  | 2.9                 | 5/5  | 13.6         |
| Chromium 4× CPU | tldraw + shadow | 1249       | 60    | 16.7     | 4.53  | 10.8                | 5/5  | 23.1         |
| Chromium 4× CPU | custom + shadow | 713        | 60.3  | 16.8     | 0.15  | 6.2                 | 5/5  | 16.5         |
| Chromium 4× CPU | custom + iframe | 511        | 60    | 16.8     | 0.21  | 4.3                 | 5/5  | 13.6         |
| Firefox         | tldraw + shadow | 517        | 114   | 9.3      | 1.95  | 8                   | 5/5  | n/a          |
| Firefox         | custom + shadow | 252        | 114.8 | 9.3      | 0.37  | 15                  | 5/5  | n/a          |
| Firefox         | custom + iframe | 133        | 120   | 9.0      | 0.10  | 15                  | 5/5  | n/a          |
| WebKit          | tldraw + shadow | 523        | 30    | 34       | 4.66  | 13                  | 5/5  | n/a          |
| WebKit          | custom + shadow | 279        | 30.3  | 34       | 2.34  | 11                  | 5/5  | n/a          |
| WebKit          | custom + iframe | 214        | 30.3  | 34       | 0.46  | 16                  | 5/5  | n/a          |

Bundle size (minified, before gzip): custom surface 732 KB (React + zod + doc-model + renderer);
tldraw adds **~1.86 MB JS + 79 KB CSS** on top.

Selection latency is single-digit to mid-teens milliseconds everywhere, i.e. within one or two
frames; the variance (Firefox/WebKit) is timer granularity in headless mode, not the engine.

### Qualitative findings

- **tldraw fights live DOM for everything inside a frame.** Its select tool routes pointer events
  to whole shapes. Selecting a node inside a frame required a capture-phase listener in front of
  tldraw's routing, and drag/resize/text-editing of inner nodes would need the same everywhere,
  while suppressing tldraw's own translate/resize/rotate of the frame shape. We'd use tldraw for
  camera and culling only and re-implement the rest.
- **Two sources of truth.** Frames would live in both the DesignDoc and tldraw's store, with two
  undo histories to reconcile (3.7 requires one history across human and agent edits).
- **Camera cost.** tldraw's reactive camera update (culling, shape transforms through React)
  costs 4.5ms per frame at 4× CPU, about 30× the custom surface's single `transform` write. That
  headroom matters during drags, when the canvas also hit-tests and re-renders nodes (3.10: no
  long tasks over 50ms during drag).
- **Licensing.** tldraw ≥ 4 needs a commercial license key for production use (a watermark
  otherwise). That's a cost and a dependency for a feature we'd mostly bypass.
- **Iframes swallow pointer events.** Clicks inside an iframe never reach the canvas, so the
  iframe variant needed `pointer-events: none` plus geometry-based routing and manual zoom
  conversion of coordinates. Every frame is a separate document (fonts and token CSS loaded per
  frame), and incremental updates need portals into each iframe document. Iframe mount was
  cheaper here only because it used the static renderer (no React per node).

## Decision

1. **Use a custom CSS-transform pan/zoom surface** (option B) in `packages/canvas`, with the
   camera applied as a single `transform` on the world layer, written directly to the DOM (not
   through React state) during gestures.
2. **Keep Shadow DOM frame containers** (`FrameView` as is). Hit-testing walks
   `elementFromPoint` into open shadow roots and resolves the closest `data-cd-id`; instance parts
   (`data-cd-part`) resolve to their instance.
3. **Overlays are screen-space.** Selection, hover, drop indicators, resize handles and
   registered overlays (`@crunch/contracts/canvas-overlay`) render in an overlay layer above the
   world, computed from node rects and the camera, so they stay crisp at every zoom and don't
   reflow frame content.
4. Don't depend on tldraw. It stays installed in `packages/canvas` until integration removes it
   from the lockfile (it's unused).

Iframes are reserved for contexts that need a separate document and script isolation without
interaction: public share pages (6.3) and visual-parity screenshots (7.1).

## Consequences

- We own camera maths, culling (if needed), gestures (wheel/pinch zoom, space-drag pan) and the
  minimap. These are small and are unit-tested in `packages/canvas`.
- Editing interactions (select, drag, resize, text) work directly against real DOM nodes, which
  makes 3.2–3.6 straightforward and keeps every edit a doc-store op.
- At the benchmark size there's no need for culling; if projects grow well beyond 20 frames,
  add `content-visibility` / viewport culling of off-screen frames.
- Re-measure on real hardware (not headless) before closing 3.10; headless fps saturates.

## Follow-up: performance budget (Story 3.10)

`apps/web/e2e/canvas/perf.spec.ts` checks the budget on a 10-frame, ~3,000-node project, in its
own serial Playwright projects. Two fixes were needed:

- **Progressive frame mounting.** On load the first frame renders at once; the rest mount one
  per task, visible frames first. First interactive frame went from 125ms to ~59ms (Chromium) and
  from 182ms to ~62ms (Firefox).
- **Per-frame doc snapshots.** An edit only hands a new doc to frames whose nodes it touched, so
  untouched frames' renderers don't re-check every node. Inspector edit main-thread time in
  Firefox went from 30–50ms to ~9ms (Chromium ~4ms).

No long tasks over 50ms were observed during a drag (Chromium Long Tasks API). Headless WebKit
(30Hz, 2x device scale) reports ~80ms, quantized to its rendering opportunities, and is held to a
looser regression guard.

What the automated checks measure (see the header of `perf.spec.ts`):

- **First interactive frame**: from `cd:load` (the doc is in memory and React starts rendering
  the editor) to the later of the first frame's content being laid out and the canvas input
  handlers being attached. Time from navigation start is logged alongside; it adds network,
  bundle download and parse, which belong to the deployment, not the canvas.
- **Long tasks during drag**: at the 3.0 benchmark size (20 frames × ~300 nodes, 6,000 nodes).
- **Inspector edit**: a real selection with the inspector mounted; the value is committed through
  the inspector's own input; median and p95 must both stay under 16ms of main-thread work.

### Manual check before release: 60fps pan/zoom on real hardware

Headless browsers cap or throttle rAF, so the 3.1 AC (60fps at the benchmark size on a mid-range
laptop) needs a person:

1. Run the harness locally (`node apps/web/e2e/canvas/harness/server.mjs`, which prints a
   `?fixture=bench20` URL) or open a project
   with 20 frames in the app, on a mid-range laptop (for example an M1/M2 MacBook Air, or an
   8th-gen Intel i5 with integrated graphics) in Chrome, Firefox and Safari.
2. Open DevTools > Performance (Safari: Timelines > Rendering Frames), start recording, then
   pan with the trackpad and pinch-zoom continuously for about 10 seconds across all frames.
3. Pass: the frame chart stays at 60fps with no dropped-frame runs longer than a few frames, and
   no main-thread task over 16ms is attributed to the canvas camera.
