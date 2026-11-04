/**
 * Scenario 7, design systems (Stories 4.1, 4.2): an admin edits a token in the workspace default
 * system. Saving the draft, and even publishing it, leaves an existing project on its pinned
 * version; only an explicit upgrade brings the change in.
 *
 * This is the only spec that edits the run's default design system.
 */
import type { Page } from '@playwright/test';
import {
  createProject,
  expectSaved,
  insertSample,
  node,
  openProject,
  SAMPLE,
  uniqueName,
} from './support/app';
import { expect, test } from './support/fixtures';

const NEW_TEXT_COLOR = '#123456';
const NEW_TEXT_RGB = 'rgb(18, 52, 86)';

const headlineColor = (page: Page) =>
  node(page, SAMPLE.headline).evaluate((el) => getComputedStyle(el).color);

test('a draft or newly published token never changes a pinned project until it is upgraded', async ({
  as,
  run,
}) => {
  test.setTimeout(90_000);
  const page = await as('admin');
  const name = uniqueName('Pinned DS');
  const projectId = await createProject(page, run.org.slug, name);
  await insertSample(page);
  const before = await headlineColor(page);
  expect(before).not.toBe(NEW_TEXT_RGB);

  // Open the default system from the design-systems page.
  await page.goto(`/w/${run.org.slug}/design-systems`);
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toBeVisible();
  const pinned = Number(/v(\d+)/.exec(await row.locator('td').nth(2).innerText())![1]);
  await page.getByRole('listitem').filter({ hasText: 'Default' }).getByRole('link').first().click();
  await expect(page.getByText(`Workspace default · Published v${pinned}`)).toBeVisible();

  // Edit color.text and save the draft.
  const input = page.getByLabel('color.text value', { exact: true });
  await input.fill(NEW_TEXT_COLOR);
  await expect(page.getByText(/· Unsaved changes/)).toBeVisible();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(
    page.getByText('Draft saved. Projects keep their pinned version until you publish.'),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('color.text value', { exact: true })).toHaveValue(NEW_TEXT_COLOR);
  await expect(page.getByText('· Draft has unpublished changes')).toBeVisible();

  // The project still renders its pinned version.
  await openProject(page, run.org.slug, projectId);
  await expect(node(page, SAMPLE.headline)).toBeVisible();
  expect(await headlineColor(page)).toBe(before);

  // Publish the draft: still no change for the pinned project, but an upgrade is offered.
  await page.goto(`/w/${run.org.slug}/design-systems`);
  await page.getByRole('listitem').filter({ hasText: 'Default' }).getByRole('link').first().click();
  await page.getByRole('button', { name: 'Publish…' }).click();
  await page
    .getByRole('dialog', { name: 'Publish version' })
    .getByRole('button', { name: 'Publish' })
    .click();
  await expect(page.getByText(`Published v${pinned + 1}.`)).toBeVisible();

  await openProject(page, run.org.slug, projectId);
  await expect(node(page, SAMPLE.headline)).toBeVisible();
  expect(await headlineColor(page)).toBe(before);

  await page.goto(`/w/${run.org.slug}/design-systems`);
  await expect(row.locator('td').nth(2)).toHaveText(`v${pinned}`);
  await expect(row.getByText(`(this project uses v${pinned})`)).toBeVisible();
  await row.getByRole('button', { name: `Upgrade to v${pinned + 1}` }).click();
  // The prompt goes away once the action has finished (not just while it's pending).
  await expect(row.getByText(/is available/)).toHaveCount(0);
  await page.reload();
  await expect(row.locator('td').nth(2)).toHaveText(`v${pinned + 1}`);

  // After the explicit upgrade the project renders the new token.
  await openProject(page, run.org.slug, projectId);
  await expect.poll(() => headlineColor(page)).toBe(NEW_TEXT_RGB);
  await expectSaved(page);
});
