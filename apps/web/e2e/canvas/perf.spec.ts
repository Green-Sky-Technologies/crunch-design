/**
 * Performance budget (Story 3.10). Runs only in the serial `*-perf` projects of
 * e2e/canvas/playwright.config.ts (one worker at a time, after the functional suite).
 *
 * What each check measures, precisely:
 * - First interactive frame (10 frames × ~300 nodes): from `cd:load` (the project's doc is in
 *   memory and React starts rendering the editor; in the app that's hydration of the editor page
 *   with the server-fetched doc) to the later of `cd:first-frame` (first frame's content laid
 *   out) and `cd:canvas-interactive` (canvas input handlers attached). Budget: 100ms. Time from
 *   navigation start is logged too (it adds network, bundle download and parse, which depend on
 *   deployment, not the canvas).
 * - Long tasks during a drag at the Story 3.0 benchmark size (20 frames × ~300 nodes): no task
 *   over 50ms (Long Tasks API, Chromium only).
 * - Inspector edit (3.3, under 16ms per edit): a real selection with the inspector mounted; each
 *   sample commits a value through the inspector's own input and measures main-thread time until
 *   React has re-rendered (inspector, layers, the frame) and layout is clean. Median and p95.
 */
import { expect, test } from './fixtures';

test.beforeEach(({}, info) => {
  test.skip(
    !info.project.name.endsWith('-perf'),
    'Timing budgets run in the serial *-perf projects',
  );
});

/** Runs in the page (serialized), so the frame count is an argument, not a closure. */
const allFramesMounted = (n: number) =>
  [...document.querySelectorAll('[data-cd-frame-host]')].filter((h) =>
    h.shadowRoot?.querySelector('[data-cd-id]'),
  ).length === n;

test.describe('canvas performance budget', () => {
  test('first interactive frame under 100ms on a 10-frame project', async ({
    canvas,
    page,
    browserName,
  }) => {
    await canvas.open('fixture=bench10');
    const t = await page.evaluate(() => {
      const at = (n: string) => performance.getEntriesByName(n)[0]?.startTime ?? NaN;
      const load = at('cd:load');
      const ready = Math.max(at('cd:first-frame'), at('cd:canvas-interactive'));
      return { interactive: ready - load, fromNavigation: ready, loadAt: load };
    });
    console.log(
      `[perf:${browserName}] interactive ${t.interactive.toFixed(1)}ms after load ` +
        `(${t.fromNavigation.toFixed(1)}ms from navigation start; doc loaded at ${t.loadAt.toFixed(1)}ms)`,
    );
    expect(t.interactive).toBeGreaterThan(0);
    // Enforced in Chromium and Firefox. Headless WebKit renders at 30Hz with the "Desktop Safari"
    // 2x device scale and reports at its next rendering opportunity (≈80ms standalone at 1x), so
    // it gets a looser regression guard.
    expect(t.interactive).toBeLessThan(browserName === 'webkit' ? 200 : 100);
    await page.waitForFunction(allFramesMounted, 10);
  });

  test('no long tasks over 50ms during a drag at the 3.0 benchmark size (20 frames)', async ({
    canvas,
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'The Long Tasks API is Chromium-only');
    await canvas.open('fixture=bench20');
    await page.waitForFunction(allFramesMounted, 20, { timeout: 20_000 });
    await page.evaluate(() => {
      const w = window as unknown as { __long: number[] };
      w.__long = [];
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) w.__long.push(e.duration);
      }).observe({ type: 'longtask', buffered: false });
    });
    // At 100% zoom, drag section 1's first card into the gap between cards 2 and 3, slowly.
    await page.evaluate(() => window.__cd.canvas.getState().setCamera({ x: 280, y: 20, z: 1 }));
    await page.waitForTimeout(100);
    const from = await canvas.box('n_b000000004'); // section 1 card 1
    const c2 = await canvas.box('n_b000000009'); // card 2
    const c3 = await canvas.box('n_b000000014'); // card 3
    const target = { x: (c2.x + c2.width + c3.x) / 2, y: c2.y + c2.height / 2 };
    await canvas.click('n_b000000004', { at: 'start' });
    await page.mouse.move(from.x + 6, from.y + 6);
    await page.mouse.down();
    for (let i = 1; i <= 40; i++) {
      await page.mouse.move(
        from.x + 6 + ((target.x - from.x - 6) * i) / 40,
        from.y + 6 + ((target.y - from.y - 6) * i) / 40,
      );
    }
    await page.mouse.up();
    await page.waitForTimeout(300);
    const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
    const doc = await canvas.doc();
    console.log(
      `[perf:${browserName}] 20 frames, ${Object.keys(doc.nodes).length} nodes; long tasks during drag: ${JSON.stringify(long.map((d) => Math.round(d)))}`,
    );
    expect(doc.nodes['n_b000000003']!.children.slice(0, 3)).toEqual([
      'n_b000000009',
      'n_b000000004',
      'n_b000000014',
    ]);
    expect(long.filter((d) => d > 50)).toEqual([]);
  });

  test('an inspector edit costs under 16ms (median and p95) with the inspector mounted', async ({
    canvas,
    page,
    browserName,
  }) => {
    await canvas.open('fixture=bench10');
    await page.waitForFunction(allFramesMounted, 10);
    // A real selection, so the inspector shows the node's fields and re-renders on each edit.
    await page.evaluate(() =>
      window.__cd.store.getState().select({ frameId: 'f_bench00000', nodeIds: ['n_b000000005'] }),
    );
    await page.getByRole('tab', { name: 'Pro' }).click();
    await page.locator('[data-prop="blur"] input').waitFor();
    const ms = await page.evaluate(async () => {
      const input = document.querySelector<HTMLInputElement>('[data-prop="blur"] input')!;
      const host = document.querySelector('[data-cd-frame-host="f_bench00000"]')!;
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      const macrotask = () =>
        new Promise<void>((r) => {
          const c = new MessageChannel();
          c.port1.onmessage = () => r();
          c.port2.postMessage(0);
        });
      const samples: number[] = [];
      for (let i = 1; i <= 20; i++) {
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
        input.focus();
        setValue.call(input, String(i));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await macrotask(); // the draft render isn't part of the edit
        const t0 = performance.now();
        input.blur(); // the inspector commits the value: one setStyle op
        await macrotask();
        host.shadowRoot!.querySelector('[data-cd-id="n_b000000005"]')!.getBoundingClientRect();
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);
      const applied = window.__cd.store.getState().doc.nodes['n_b000000005']!.style.lg?.blur;
      return { median: samples[10]!, p95: samples[18]!, max: samples[19]!, applied };
    });
    console.log(
      `[perf:${browserName}] inspector edit median ${ms.median.toFixed(1)}ms p95 ${ms.p95.toFixed(1)}ms max ${ms.max.toFixed(1)}ms`,
    );
    expect(ms.applied).toBe(20);
    expect(ms.median).toBeLessThan(16);
    expect(ms.p95).toBeLessThan(16);
  });
});
