/**
 * Playwright fixtures for the canvas suite (Story 3.9). Each worker bundles and serves the canvas
 * harness (harness/main.tsx), so these specs need no app server or Clerk session and run under
 * either playwright config. Helpers reach into frames' shadow roots by `data-cd-id`.
 */
import { test as base, expect, type Page } from '@playwright/test';
import { startHarness } from './harness/server.mjs';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const test = base.extend<{ canvas: Canvas }, { harnessUrl: string }>({
  harnessUrl: [
    // Playwright's fixture callback is conventionally `use`; it's named `provide` here so the
    // React hooks lint rule doesn't mistake it for React's use().
    async ({}, provide) => {
      const h = await startHarness();
      await provide(h.url);
      await h.close();
    },
    { scope: 'worker', timeout: 120_000 },
  ],
  canvas: async ({ page, harnessUrl }, provide) => {
    await provide(new Canvas(page, harnessUrl));
  },
});

export { expect };

export class Canvas {
  constructor(
    readonly page: Page,
    readonly base: string,
  ) {}

  async open(query = '') {
    const errors: string[] = [];
    this.page.on('pageerror', (e) => errors.push(String(e)));
    await this.page.goto(`${this.base}/?${query}`);
    await this.page.waitForFunction(() => window.__cd !== undefined);
    await this.settle();
    return errors;
  }

  /** Wait until the camera has been fitted and stops moving (positions are then stable). */
  async settle() {
    await this.page.waitForFunction(() => window.__cd.canvas.getState().fitted);
    let prev = '';
    for (let i = 0; i < 40; i++) {
      const cam = await this.page.evaluate(() =>
        JSON.stringify([window.__cd.canvas.getState().camera, window.__cd.canvas.getState().sizes]),
      );
      if (cam === prev) return;
      prev = cam;
      await this.page.waitForTimeout(60);
    }
  }

  /** Client rect of a rendered node inside a frame's shadow root. */
  box(id: string): Promise<Box> {
    return this.page.evaluate((id) => {
      for (const host of document.querySelectorAll('[data-cd-frame-host]')) {
        const el = host.shadowRoot?.querySelector(`[data-cd-id="${id}"]`);
        if (el) {
          const r = el.getBoundingClientRect();
          return { x: r.left, y: r.top, width: r.width, height: r.height };
        }
      }
      throw new Error(`node ${id} not rendered`);
    }, id);
  }

  async click(id: string, opts: { shift?: boolean; at?: 'center' | 'start' } = {}) {
    const b = await this.box(id);
    const x = opts.at === 'start' ? b.x + 6 : b.x + b.width / 2;
    const y = opts.at === 'start' ? b.y + 6 : b.y + Math.min(b.height / 2, 12);
    if (opts.shift) await this.page.keyboard.down('Shift');
    await this.page.mouse.click(x, y);
    if (opts.shift) await this.page.keyboard.up('Shift');
  }

  async drag(from: { x: number; y: number }, to: { x: number; y: number }) {
    await this.page.mouse.move(from.x, from.y);
    await this.page.mouse.down();
    await this.page.mouse.move(from.x + 6, from.y + 6, { steps: 2 });
    await this.page.mouse.move(to.x, to.y, { steps: 10 });
    await this.page.mouse.up();
  }

  doc() {
    return this.page.evaluate(() => window.__cd.store.getState().doc);
  }

  selection() {
    return this.page.evaluate(() => window.__cd.store.getState().selection);
  }

  undoLabels() {
    return this.page.evaluate(() => window.__cd.store.getState().undoStack.map((s) => s.label));
  }

  /** Computed style of a rendered node. */
  computed(id: string, prop: string) {
    return this.page.evaluate(
      ([id, prop]) => {
        const host = document.querySelector('[data-cd-frame-host]')!;
        const el = host.shadowRoot!.querySelector(`[data-cd-id="${id}"]`)!;
        return getComputedStyle(el).getPropertyValue(prop);
      },
      [id, prop] as const,
    );
  }

  isEditing(id: string) {
    return this.page.evaluate((id) => {
      const host = document.querySelector('[data-cd-frame-host]')!;
      return !!host.shadowRoot!.querySelector(`[data-cd-id="${id}"][contenteditable]`);
    }, id);
  }
}
