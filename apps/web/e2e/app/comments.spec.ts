/**
 * Scenario 5, comments (Story 6.1): an editor pins a comment to an element; a viewer sees the pin
 * and the thread but has no composer, reply or resolve controls.
 */
import {
  clickNode,
  createProject,
  insertSample,
  openProject,
  SAMPLE,
  uniqueName,
} from './support/app';
import { expect, test } from './support/fixtures';

test('an editor pins a comment on an element and a viewer can read it', async ({ as, run }) => {
  const editor = await as('editor');
  const projectId = await createProject(editor, run.org.slug, uniqueName('Comments'));
  await insertSample(editor);

  await clickNode(editor, SAMPLE.headline);
  await editor.getByRole('button', { name: /^Comments/ }).click();
  await expect(editor.getByText(/Commenting on .*Headline/)).toBeVisible();
  const body = `Tighten this headline ${Date.now().toString(36)}`;
  await editor.getByPlaceholder('Add a comment… use @ to mention').fill(body);
  await editor.getByRole('button', { name: 'Comment', exact: true }).click();
  const thread = editor.locator('[data-thread-id]').filter({ hasText: body });
  await expect(thread).toBeVisible();
  await expect(thread.getByRole('button', { name: /Headline/ })).toBeVisible();
  await expect(editor.locator('[data-comment-pin]')).toHaveCount(1);
  await expect(editor.getByRole('button', { name: 'Comments (1)' })).toBeVisible();

  const viewer = await as('viewer');
  await openProject(viewer, run.org.slug, projectId);
  await expect(viewer.getByRole('button', { name: 'Comments (1)' })).toBeVisible();
  const pin = viewer.locator('[data-comment-pin]');
  await expect(pin).toHaveCount(1);
  await expect(pin).toHaveAttribute('title', body);
  await pin.click();
  const seen = viewer.locator('[data-thread-id]').filter({ hasText: body });
  await expect(seen).toBeVisible();
  await expect(
    viewer.getByText('You have view-only access, so you can read comments but not add them.'),
  ).toBeVisible();
  await expect(viewer.getByPlaceholder('Add a comment… use @ to mention')).toHaveCount(0);
  await expect(viewer.getByPlaceholder('Reply…')).toHaveCount(0);
  await expect(seen.getByRole('button', { name: 'Resolve' })).toHaveCount(0);
  await expect(seen.getByRole('button', { name: 'Reply' })).toHaveCount(0);

  // And the API refuses a viewer's comment.
  const res = await viewer.evaluate(async (id) => {
    const r = await fetch('/api/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: id,
        anchor: { type: 'canvas', x: 0, y: 0 },
        body: 'viewer comment',
        mentions: [],
        kind: 'discussion',
      }),
    });
    return r.status;
  }, projectId);
  expect(res).toBe(403);
});
