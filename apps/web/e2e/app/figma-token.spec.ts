/**
 * Scenario 9, Figma plugin tokens (Story 8.1): an admin creates a token in Settings → Figma
 * (shown once), the plugin API lists the workspace's projects with it as a bearer token, and a
 * revoked token is rejected.
 */
import { createProject, uniqueName } from './support/app';
import { expect, test } from './support/fixtures';

test('a plugin token lists the workspace’s projects until it is revoked', async ({
  as,
  run,
  request,
}) => {
  const page = await as('admin');
  const project = uniqueName('Figma listed');
  const projectId = await createProject(page, run.org.slug, project);

  await page.goto(`/w/${run.org.slug}/settings/figma`);
  const tokenName = uniqueName('e2e token');
  await page.getByLabel('Token name').fill(tokenName);
  await page.getByRole('button', { name: 'Create token' }).click();
  const fresh = page.getByText('New token (shown once)').locator('..');
  await expect(fresh).toBeVisible();
  const token = (await fresh.locator('code').innerText()).trim();
  expect(token.length).toBeGreaterThan(20);
  const row = page.getByRole('listitem').filter({ hasText: tokenName });
  await expect(row).toContainText('never used');
  // The secret is shown once: after Done (or a reload) only its hint remains.
  await fresh.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText(token)).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('listitem').filter({ hasText: tokenName })).toBeVisible();
  await expect(page.getByText(token)).toHaveCount(0);

  const auth = { Authorization: `Bearer ${token}` };
  const res = await request.get('/api/figma/plugin/projects', { headers: auth });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { projects: { id: string; name: string }[] };
  expect(body.projects).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: projectId, name: project })]),
  );

  // No token, or a made-up one: 401.
  expect((await request.get('/api/figma/plugin/projects')).status()).toBe(401);
  expect(
    (
      await request.get('/api/figma/plugin/projects', {
        headers: { Authorization: `Bearer ${token.slice(0, -4)}AAAA` },
      })
    ).status(),
  ).toBe(401);

  await page
    .getByRole('listitem')
    .filter({ hasText: tokenName })
    .getByRole('button', { name: 'Revoke' })
    .click();
  await expect(page.getByRole('listitem').filter({ hasText: tokenName })).toHaveCount(0);
  const revoked = await request.get('/api/figma/plugin/projects', { headers: auth });
  expect(revoked.status()).toBe(401);
});
