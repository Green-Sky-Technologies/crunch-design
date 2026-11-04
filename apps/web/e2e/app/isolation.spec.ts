/**
 * Scenario 3, workspace isolation: a signed-in user from another workspace can't open a project,
 * read it through the API (always 404, never 403, never data) or use a workspace-only share link.
 */
import { createProject, insertSample, pageFetch, SAMPLE, uniqueName } from './support/app';
import { expect, test } from './support/fixtures';

test('an outsider can’t reach another workspace’s project, page or API', async ({ as, run }) => {
  const editor = await as('editor');
  const name = uniqueName('Isolated');
  const projectId = await createProject(editor, run.org.slug, name);
  await insertSample(editor);

  const outsider = await as('outsider');
  await outsider.goto(`/w/${run.org.slug}`);
  // Not a member: the URL can't activate that org, so they land in their own workspace.
  await expect(outsider).toHaveURL(new RegExp(`/w/${run.outsiderOrg.slug}$`));
  await outsider.goto(`/w/${run.org.slug}/p/${projectId}`);
  await expect(outsider).toHaveURL(new RegExp(`/w/${run.outsiderOrg.slug}$`));
  await expect(outsider.getByText(name)).toHaveCount(0);

  for (const url of [
    `/api/projects/${projectId}/doc`,
    `/api/projects/${projectId}/doc?since=0`,
    `/api/projects/${projectId}/lock?sessionId=e2e`,
    `/api/export/${projectId}?format=html`,
    `/api/versions?projectId=${projectId}`,
  ]) {
    const res = await pageFetch(outsider, url);
    expect(res.status, url).toBe(404);
    expect(res.body, url).not.toContain(SAMPLE.headlineText);
    expect(res.body, url).not.toContain(name);
  }
  // Writes are refused the same way.
  const write = await pageFetch(outsider, `/api/projects/${projectId}/lock`, {
    method: 'POST',
    body: { sessionId: 'e2e-outsider' },
  });
  expect(write.status).toBe(404);

  // A member of the workspace can read the same document (the 404 above isn't a broken route).
  const own = await pageFetch(editor, `/api/projects/${projectId}/doc`);
  expect(own.status).toBe(200);
  expect(own.body).toContain(SAMPLE.headlineText);
});

test('a workspace-only share link opens for members but not for an outsider', async ({
  as,
  anonymous,
  run,
}) => {
  const editor = await as('editor');
  await createProject(editor, run.org.slug, uniqueName('Workspace link'));
  await insertSample(editor);
  await editor.getByRole('button', { name: 'Share' }).click();
  await expect(editor.getByRole('radio', { name: /Workspace members/ })).toBeChecked();
  await editor.getByRole('button', { name: 'Create link' }).click();
  const url = await editor
    .getByRole('status')
    .filter({ hasText: 'link created' })
    .locator('input')
    .inputValue();
  const path = new URL(url).pathname;
  expect(path).toMatch(/^\/s\/[^/]+$/);

  const viewer = await as('viewer');
  // Load a workspace page first so the session is fresh, then open the link.
  await viewer.goto(`/w/${run.org.slug}`);
  const ok = await viewer.goto(path);
  expect(ok?.status()).toBe(200);
  await expect(viewer.getByText(SAMPLE.headlineText)).toBeVisible();

  const outsider = await as('outsider');
  await outsider.goto(`/w/${run.outsiderOrg.slug}`);
  const denied = await outsider.goto(path);
  expect(denied?.status()).toBe(404);
  await expect(outsider.getByText(SAMPLE.headlineText)).toHaveCount(0);

  const anon = await anonymous();
  const anonRes = await anon.goto(path);
  expect(anonRes?.status()).toBe(404);
  await expect(anon.getByText(SAMPLE.headlineText)).toHaveCount(0);
});
