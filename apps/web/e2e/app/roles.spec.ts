/**
 * Scenario 2, roles (SPEC §3): a viewer gets a read-only editor but can still run a
 * deterministic export, and is kept out of admin settings; an editor doesn't see Model access.
 */
import { readFile } from 'node:fs/promises';
import {
  clickNode,
  createProject,
  insertSample,
  node,
  openProject,
  SAMPLE,
  stableBox,
  uniqueName,
} from './support/app';
import { expect, test } from './support/fixtures';

test('a viewer sees the project read-only and can export HTML', async ({ as, run }) => {
  const editor = await as('editor');
  const projectId = await createProject(editor, run.org.slug, uniqueName('Roles'));
  await insertSample(editor);

  const page = await as('viewer');
  await openProject(page, run.org.slug, projectId);
  const lock = page.getByTestId('edit-lock');
  await expect(lock.getByText('View only')).toBeVisible();
  // Viewers still heartbeat presence: the editor shows up in their avatar list, and nothing is
  // reported offline.
  await expect(lock.getByRole('listitem')).toHaveCount(2);
  await expect(lock.getByText('· offline')).toHaveCount(0);
  await expect(node(page, SAMPLE.headline)).toHaveText(SAMPLE.headlineText);
  await expect(page.getByRole('button', { name: 'Insert a sample design' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '+ Frame' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Share' })).toHaveCount(0);
  await expect(
    page.getByText('You have view access. Ask an editor to make changes.'),
  ).toBeVisible();

  // Selecting works (to inspect), but the inspector is disabled and text can't be edited.
  await clickNode(page, SAMPLE.headline);
  await expect(page.locator('[data-prop="letterSpacing"] input')).toBeDisabled();
  await expect(page.locator('[data-handle]')).toHaveCount(0);
  const b = await stableBox(node(page, SAMPLE.headline));
  await page.mouse.dblclick(b.x + 20, b.y + 10);
  await expect(page.locator(`[data-cd-id="${SAMPLE.headline}"][contenteditable]`)).toHaveCount(0);

  // No comment composer.
  await page.getByRole('button', { name: /^Comments/ }).click();
  await expect(
    page.getByText('You have view-only access, so you can read comments but not add them.'),
  ).toBeVisible();
  await expect(page.getByPlaceholder('Add a comment… use @ to mention')).toHaveCount(0);

  // Deterministic export is allowed for viewers.
  await page.getByRole('button', { name: 'Export' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: /HTML page/ }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.html$/);
  const html = await readFile((await download.path())!, 'utf8');
  expect(html).toContain(SAMPLE.headlineText);

  // The server enforces the role too: a doc write from the viewer's session is forbidden.
  const res = await page.evaluate(async (id) => {
    const r = await fetch(`/api/projects/${id}/doc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseVersion: 0, txn: { ops: [] } }),
    });
    return r.status;
  }, projectId);
  expect(res).toBe(403);
});

test('a viewer is redirected away from admin settings', async ({ as, run }) => {
  const page = await as('viewer');
  for (const path of ['settings/credentials', 'settings/usage']) {
    await page.goto(`/w/${run.org.slug}/${path}`);
    await expect(page).toHaveURL(new RegExp(`/w/${run.org.slug}$`));
  }
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  const nav = page.getByRole('banner');
  await expect(nav.getByRole('link', { name: 'Model access' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Figma' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New project' })).toHaveCount(0);

  // Read-only pages open (and don't error) for viewers; the design-system editor is locked.
  await page.goto(`/w/${run.org.slug}/settings/members`);
  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
  await page.goto(`/w/${run.org.slug}/design-systems`);
  await expect(page.getByRole('heading', { name: 'Design systems' })).toBeVisible();
  await page.getByRole('listitem').filter({ hasText: 'Default' }).getByRole('link').first().click();
  await expect(page.getByRole('tab', { name: 'Tokens' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save draft' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Publish…' })).toHaveCount(0);
  await expect(page.getByLabel('color.text value', { exact: true })).toBeDisabled();
});

test('an editor has no Model access and is redirected from it', async ({ as, run }) => {
  const page = await as('editor');
  await page.goto(`/w/${run.org.slug}`);
  const nav = page.getByRole('banner');
  await expect(nav.getByRole('navigation').getByRole('link', { name: 'Projects' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Model access' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Usage' })).toHaveCount(0);
  await page.goto(`/w/${run.org.slug}/settings/credentials`);
  await expect(page).toHaveURL(new RegExp(`/w/${run.org.slug}$`));

  const admin = await as('admin');
  await admin.goto(`/w/${run.org.slug}`);
  await expect(admin.getByRole('banner').getByRole('link', { name: 'Model access' })).toBeVisible();
});
