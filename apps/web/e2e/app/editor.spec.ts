/**
 * Scenario 1, editor happy path: create a project, insert the sample design, edit text inline on
 * the canvas, see it saved, reload and find it persisted, and undo/redo from the toolbar.
 */
import {
  createProject,
  editText,
  expectEditing,
  expectSaved,
  insertSample,
  node,
  setMode,
  SAMPLE,
  stableBox,
  uniqueName,
} from './support/app';
import { expect, test } from './support/fixtures';

test('an editor creates a project, edits text on the canvas, and it persists', async ({
  as,
  run,
}) => {
  const page = await as('editor');
  const name = uniqueName('Happy path');
  await createProject(page, run.org.slug, name);
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await setMode(page, 'Edit');
  const undo = page.getByRole('button', { name: 'Undo' });
  const redo = page.getByRole('button', { name: 'Redo' });
  await expect(undo).toBeDisabled();

  await insertSample(page);
  await expect(node(page, SAMPLE.headline)).toHaveText(SAMPLE.headlineText);
  await expect(undo).toBeEnabled();
  // Leave Edit mode with Save; the canvas becomes a preview again.
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'View' })).toHaveAttribute('aria-checked', 'true');
  const hb = await stableBox(node(page, SAMPLE.headline));
  await page.mouse.dblclick(hb.x + 20, hb.y + 10);
  await expect(page.locator(`[data-cd-id="${SAMPLE.headline}"][contenteditable]`)).toHaveCount(0);

  const edited = `Edited ${Date.now().toString(36)}`;
  await editText(page, SAMPLE.headline, edited);
  await expect(node(page, SAMPLE.headline)).toHaveText(edited);
  await expectSaved(page);

  await page.reload();
  await expectEditing(page);
  await expect(node(page, SAMPLE.headline)).toHaveText(edited);
  await expectSaved(page);

  // History is per session; make a fresh edit, then undo and redo it through the toolbar.
  await editText(page, SAMPLE.headline, 'Second edit'); // enters Edit mode
  await expectSaved(page);
  await undo.click();
  await expect(node(page, SAMPLE.headline)).toHaveText(edited);
  await expect(redo).toBeEnabled();
  await expectSaved(page);
  await redo.click();
  await expect(node(page, SAMPLE.headline)).toHaveText('Second edit');
  await expect(redo).toBeDisabled();
  await expectSaved(page);

  // The undo was saved to the server too: a fresh load shows the redone text.
  await page.reload();
  await expect(node(page, SAMPLE.headline)).toHaveText('Second edit');
});

test('the editor panes fit the viewport (agent pane is not cut off)', async ({ as, run }) => {
  const page = await as('editor');
  await page.setViewportSize({ width: 1280, height: 720 });
  await createProject(page, run.org.slug, uniqueName('Layout'));
  const viewport = page.viewportSize()!;
  for (const aside of await page.locator('aside').all()) {
    const box = (await aside.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  }
});
