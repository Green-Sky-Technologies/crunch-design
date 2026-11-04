/**
 * Archived projects are read-only (the server refuses doc commits and comments until the project
 * is restored), so the editor must open them read-only instead of accepting edits it can't save.
 */
import {
  clickNode,
  createProject,
  expectEditing,
  insertSample,
  node,
  SAMPLE,
  stableBox,
  uniqueName,
} from './support/app';
import { expect, test } from './support/fixtures';

test('an archived project opens read-only until it is restored', async ({ as, run }) => {
  const page = await as('editor');
  const name = uniqueName('Archived');
  const projectId = await createProject(page, run.org.slug, name);
  await insertSample(page);

  await page.goto(`/w/${run.org.slug}`);
  const card = page.getByRole('listitem').filter({ hasText: name });
  await card.getByRole('button', { name: 'Project actions' }).click();
  await card.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(card).toHaveCount(0);

  await page.goto(`/w/${run.org.slug}?archived=1`);
  await page.getByRole('link', { name: `Open ${name}` }).click();
  await page.waitForURL(new RegExp(`/p/${projectId}$`));
  const lock = page.getByTestId('edit-lock');
  await expect(lock.getByText('Archived')).toBeVisible();
  await expect(node(page, SAMPLE.headline)).toHaveText(SAMPLE.headlineText);
  await expect(page.getByRole('button', { name: '+ Frame' })).toHaveCount(0);

  // No inline editing, no inspector edits, no comment composer, no agent.
  await clickNode(page, SAMPLE.headline);
  await expect(page.locator('[data-prop="letterSpacing"] input')).toBeDisabled();
  const b = await stableBox(node(page, SAMPLE.headline));
  await page.mouse.dblclick(b.x + 20, b.y + 10);
  await expect(page.locator(`[data-cd-id="${SAMPLE.headline}"][contenteditable]`)).toHaveCount(0);
  await page.getByRole('button', { name: /^Comments/ }).click();
  await expect(page.getByPlaceholder('Add a comment… use @ to mention')).toHaveCount(0);
  await expect(page.getByText(/This project is archived/).first()).toBeVisible();
  await expect(page.getByText(/A change was rejected/)).toHaveCount(0);

  // Exports still work for archived projects.
  await page.getByRole('button', { name: 'Export' }).click();
  await expect(page.getByRole('menuitem', { name: /HTML page/ })).toBeEnabled();
  await page.keyboard.press('Escape');

  // Restore: the editor is editable again.
  await page.goto(`/w/${run.org.slug}?archived=1`);
  const archivedCard = page.getByRole('listitem').filter({ hasText: name });
  await archivedCard.getByRole('button', { name: 'Project actions' }).click();
  await archivedCard.getByRole('menuitem', { name: 'Restore' }).click();
  await expect(archivedCard).toHaveCount(0);
  await page.goto(`/w/${run.org.slug}/p/${projectId}`);
  await expectEditing(page);
  await expect(page.getByTestId('edit-lock').getByText('Archived')).toHaveCount(0);
});
