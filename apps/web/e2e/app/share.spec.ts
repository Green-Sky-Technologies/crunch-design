/**
 * Scenario 6, public share links (Story 6.3): an editor creates a public link; an anonymous
 * visitor sees the rendered design with the share viewer's security headers; after the editor
 * revokes it, the link is a 404.
 */
import {
  createProject,
  editText,
  expectSaved,
  insertSample,
  SAMPLE,
  uniqueName,
} from './support/app';
import { expect, test } from './support/fixtures';

test('a public link renders for anonymous visitors until it is revoked', async ({
  as,
  anonymous,
  run,
}) => {
  const editor = await as('editor');
  const name = uniqueName('Public link');
  await createProject(editor, run.org.slug, name);
  await insertSample(editor);
  const headline = `Shared ${Date.now().toString(36)}`;
  await editText(editor, SAMPLE.headline, headline);
  await expectSaved(editor);

  await editor.getByRole('button', { name: 'Share' }).click();
  await editor.getByRole('radio', { name: /Anyone with the link/ }).check();
  await editor.getByRole('button', { name: 'Create link' }).click();
  const created = editor.getByRole('status').filter({ hasText: 'Public link created' });
  const url = new URL(await created.locator('input').inputValue());
  expect(url.pathname).toMatch(/^\/s\/[^/]+$/);
  const item = editor.getByRole('listitem').filter({ hasText: 'Anyone with the link' });
  await expect(item.getByText('No expiry')).toBeVisible();

  const anon = await anonymous();
  const res = await anon.goto(url.pathname);
  expect(res?.status()).toBe(200);
  await expect(anon.getByText(headline)).toBeVisible();
  // Only the design: nothing about the workspace or project.
  await expect(anon.getByText(name)).toHaveCount(0);
  await expect(anon.getByText(run.org.name)).toHaveCount(0);
  expect(await anon.locator('script').count()).toBe(0);

  const h = res!.headers();
  expect(h['x-robots-tag']).toContain('noindex');
  const csp = h['content-security-policy'] ?? '';
  expect(csp).toContain("default-src 'none'");
  expect(csp).not.toContain('script-src');
  expect(csp).toContain("frame-ancestors 'none'");
  expect(h['referrer-policy']).toBe('no-referrer');
  expect(h['cache-control']).toContain('no-store');

  // Revoke (confirmed in a native dialog); the link stops working.
  editor.once('dialog', (d) => void d.accept());
  await item.getByRole('button', { name: 'Revoke' }).click();
  await expect(item.getByText('Revoked')).toBeVisible();
  const gone = await anon.goto(url.pathname);
  expect(gone?.status()).toBe(404);
  await expect(anon.getByText(headline)).toHaveCount(0);
  expect(gone!.headers()['x-robots-tag']).toContain('noindex');
});
