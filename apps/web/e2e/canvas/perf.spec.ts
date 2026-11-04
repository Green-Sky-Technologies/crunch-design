/**
 * Performance budget (Story 3.10), on the benchmark project (10 frames of ~300 nodes):
 * - under 100ms from project load (doc in memory, React starts rendering) to the first
 *   interactive frame (content laid out and canvas input handlers attached);
 * - no long tasks over 50ms while dragging (Long Tasks API: Chromium only);
 * - an inspector edit applies in under 16ms of main-thread work (3.3): op, React commit and layout.
 * Numbers are logged so regressions are visible even when within budget.
 * Runs only in the `*-perf` projects of e2e/canvas/playwright.config.ts (serial, unloaded).
 */
import { expect, test } from './fixtures';

test.beforeEach(({}, info) => {
  test.skip(
    !info.project.name.endsWith('-perf'),
    'Timing budgets run in the serial *-perf projects',
  );
});

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
      return {
        firstFrame: at('cd:first-frame') - load,
        interactive: Math.max(at('cd:first-frame'), at('cd:canvas-interactive')) - load,
      };
    });
    console.log(
      `[perf:${browserName}] first frame ${t.firstFrame.toFixed(1)}ms, interactive ${t.interactive.toFixed(1)}ms`,
    );
    expect(t.interactive).toBeGreaterThan(0);
    // The 100ms budget is enforced in Chromium and Firefox. Headless WebKit renders at 30Hz with
    // the "Desktop Safari" 2x device scale and only delivers the measurement at a rendering
    // opportunity, so its number is quantized upwards (≈80ms standalone at 1x); it gets a looser
    // regression guard instead of the budget.
    expect(t.interactive).toBeLessThan(browserName === 'webkit' ? 200 : 100);
    // and every frame does mount eventually
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            [...document.querySelectorAll('[data-cd-frame-host]')].filter((h) =>
              h.shadowRoot?.querySelector('[data-cd-id]'),
            ).length,
        ),
      )
      .toBe(10);
  });

  test('no long tasks over 50ms during a drag', async ({ canvas, page, browserName }) => {
    test.skip(browserName !== 'chromium', 'The Long Tasks API is Chromium-only');
    await canvas.open('fixture=bench10');
    // wait for progressive mounting to finish so it doesn't count against the drag
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[data-cd-frame-host]')].filter((h) =>
          h.shadowRoot?.querySelector('[data-cd-id]'),
        ).length === 10,
    );
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
      `[perf:${browserName}] long tasks during drag: ${JSON.stringify(long.map((d) => Math.round(d)))}`,
    );
    // card 1 now sits between cards 2 and 3
    expect(doc.nodes['n_b000000003']!.children.slice(0, 3)).toEqual([
      'n_b000000009',
      'n_b000000004',
      'n_b000000014',
    ]);
    expect(long.filter((d) => d > 50)).toEqual([]);
  });

  test('an inspector edit costs under 16ms of main-thread work', async ({
    canvas,
    page,
    browserName,
  }) => {
    await canvas.open('fixture=bench10');
    const ms = await page.evaluate(async () => {
      const s = window.__cd.store.getState();
      const id = 'n_b000000005'; // a card title in the first frame
      const host = document.querySelector('[data-cd-frame-host="f_bench00000"]')!;
      const macrotask = () =>
        new Promise<void>((r) => {
          const c = new MessageChannel();
          c.port1.onmessage = () => r();
          c.port2.postMessage(0);
        });
      const samples: number[] = [];
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => requestAnimationFrame(() => r(undefined))); // start idle
        const t0 = performance.now();
        s.apply([{ op: 'setStyle', id, breakpoint: 'lg', prop: 'letterSpacing', value: i }], {
          source: 'inspector',
          coalesceKey: 'perf',
        });
        // React flushes the store update (and the frame's node re-render) before the next task.
        await macrotask();
        // Include the style/layout the edit causes.
        host.shadowRoot!.querySelector(`[data-cd-id="${id}"]`)!.getBoundingClientRect();
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);
      return { median: samples[6]!, max: samples[11]! };
    });
    console.log(
      `[perf:${browserName}] inspector edit median ${ms.median.toFixed(1)}ms max ${ms.max.toFixed(1)}ms (main thread)`,
    );
    expect(ms.median).toBeLessThan(16);
  });
});
