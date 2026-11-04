/**
 * Scenario 5, comments (Story 6.1): an editor pins a comment to an element; a viewer sees the pin
 * and the thread but has no composer, reply or resolve controls.
 */
import {
  clickNode,
  setMode,
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

  // Comment mode: click the element, write, and post it as a human comment.
  await setMode(editor, 'Comment');
  await clickNode(editor, SAMPLE.headline);
  const popover = editor.getByRole('dialog', { name: 'Comment on element' });
  await expect(popover).toBeVisible();
  const body = `Tighten this headline ${Date.now().toString(36)}`;
  await popover.getByRole('textbox').fill(body);
  await popover.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(popover).toHaveCount(0);
  // The comments pane opens over the chat pane.
  await expect(editor.getByRole('dialog', { name: 'Comments' })).toBeVisible();
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
