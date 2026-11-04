/**
 * Page helpers for driving the real app. Canvas nodes render inside each frame's open shadow
 * root; Playwright's CSS engine pierces it, so `[data-cd-id=…]` finds them directly.
 */
import { expect, type Locator, type Page } from '@playwright/test';

/** Node ids of the built-in sample design (packages/doc-model fixtures: sampleLandingDoc). */
export const SAMPLE = {
  headline: 'n_herotitle1',
  headlineText: 'Ship designs your engineers can build.',
  body: 'n_herobody01',
} as const;

export const uniqueName = (prefix: string) =>
  `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Create a project through the projects page; lands in the editor. Returns the project id. */
export async function createProject(page: Page, slug: string, name: string): Promise<string> {
  await page.goto(`/w/${slug}`);
  await page.getByRole('button', { name: 'New project' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await page.waitForURL(new RegExp(`/w/${slug}/p/[^/?#]+$`));
  const id = new URL(page.url()).pathname.split('/').pop()!;
  await expectEditorReady(page);
  return id;
}

export async function openProject(page: Page, slug: string, projectId: string) {
  await page.goto(`/w/${slug}/p/${projectId}`);
  await expectEditorReady(page);
}

export async function expectEditorReady(page: Page) {
  await expect(page.getByRole('link', { name: 'All projects' })).toBeVisible();
  await expect(page.getByTestId('edit-lock')).toBeVisible();
}

export const saveStatus = (page: Page) =>
  page.getByText(/^(Saved|Unsaved changes|Saving…|Save failed|Offline, will retry)$/);

/** Wait for the doc store to have flushed everything to the server. */
export async function expectSaved(page: Page) {
  await expect(saveStatus(page)).toHaveText('Saved', { timeout: 15_000 });
}

/** The editor holds the edit lock (the canvas is editable). */
export async function expectEditing(page: Page, timeout = 15_000) {
  await expect(page.getByTestId('edit-lock').getByText('Editing', { exact: true })).toBeVisible({
    timeout,
  });
}

/** Insert the sample design into an empty project and wait for it to be saved and rendered. */
export async function insertSample(page: Page) {
  await expectEditing(page);
  await page.getByRole('button', { name: 'Insert a sample design' }).click();
  await expect(node(page, SAMPLE.headline)).toBeVisible();
  await expectSaved(page);
}

export const node = (page: Page, id: string): Locator => page.locator(`[data-cd-id="${id}"]`);

/** A node's box once the camera has stopped moving (fit-to-content animates after loads). */
export async function stableBox(loc: Locator) {
  let prev = '';
  let box: Awaited<ReturnType<Locator['boundingBox']>> = null;
  await expect
    .poll(
      async () => {
        box = await loc.boundingBox();
        const key = JSON.stringify(box);
        const same = box !== null && key === prev;
        prev = key;
        return same;
      },
      { intervals: [50, 100, 100, 200] },
    )
    .toBe(true);
  return box!;
}

/** Click a canvas node near its top-left text (selection goes through the canvas overlay). */
export async function clickNode(page: Page, id: string) {
  const b = await stableBox(node(page, id));
  await page.mouse.click(b.x + Math.min(b.width / 2, 40), b.y + Math.min(b.height / 2, 12));
}

/** Switch the editor to a mode (View / Edit / Comment) with the top-bar switch. */
export async function setMode(page: Page, mode: 'View' | 'Edit' | 'Comment') {
  const radio = page.getByRole('radio', { name: mode });
  if ((await radio.getAttribute('aria-checked')) !== 'true') await radio.click();
  await expect(radio).toHaveAttribute('aria-checked', 'true');
}

/** Double-click a text node (in Edit mode), replace its text and commit with Enter. */
export async function editText(page: Page, id: string, text: string) {
  await setMode(page, 'Edit');
  const b = await stableBox(node(page, id));
  await page.mouse.dblclick(b.x + Math.min(b.width / 2, 40), b.y + Math.min(b.height / 2, 12));
  await expect(page.locator(`[data-cd-id="${id}"][contenteditable]`)).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect(page.locator(`[data-cd-id="${id}"][contenteditable]`)).toHaveCount(0);
}

/** fetch() from inside the page, so the request carries the live (auto-refreshed) Clerk session. */
export async function pageFetch(
  page: Page,
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: string }> {
  return page.evaluate(
    async ({ url, init }) => {
      const r = await fetch(url, {
        method: init.method ?? 'GET',
        cache: 'no-store',
        headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      return { status: r.status, body: await r.text() };
    },
    { url, init },
  );
}
