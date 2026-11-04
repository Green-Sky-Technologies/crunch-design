/**
 * Scenario 4, the edit lock with two real editor accounts in separate browser contexts
 * (Story 3.8): A holds the lock; B sees someone else editing and can't edit; B requests control;
 * A hands over (or closes the tab) and B can edit, with A's changes loaded.
 *
 * Timing comes from the lock client: the holder heartbeats every 20s (that's when A sees B's
 * request) and a waiting editor polls every 5s (that's when B adopts a freed lock).
 */
import type { Page } from '@playwright/test';
import {
  createProject,
  editText,
  expectEditing,
  expectSaved,
  insertSample,
  node,
  openProject,
  SAMPLE,
  stableBox,
  uniqueName,
} from './support/app';
import { expect, test } from './support/fixtures';

const HEARTBEAT_WAIT = 35_000;

async function expectLockedOut(page: Page) {
  const lock = page.getByTestId('edit-lock');
  await expect(lock.getByText(/is editing$/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Insert a sample design' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '+ Frame' })).toHaveCount(0);
  // Double-clicking text doesn't start editing.
  const b = await stableBox(node(page, SAMPLE.headline));
  await page.mouse.dblclick(b.x + 20, b.y + 10);
  await expect(page.locator(`[data-cd-id="${SAMPLE.headline}"][contenteditable]`)).toHaveCount(0);
}

test.describe('edit lock between two editors', () => {
  test.describe.configure({ timeout: 120_000 });

  test('B requests control and A hands over', async ({ as, run }) => {
    const a = await as('editor');
    const projectId = await createProject(a, run.org.slug, uniqueName('Lock handover'));
    await insertSample(a);

    const b = await as('editor2');
    await openProject(b, run.org.slug, projectId);
    await expectLockedOut(b);

    // The lock API agrees: B's write is refused while A holds the lock.
    const state = await b.evaluate(async (id) => {
      const r = await fetch(`/api/projects/${id}/lock?sessionId=e2e-probe`, { cache: 'no-store' });
      return (await r.json()) as { lock: { isMine: boolean } | null };
    }, projectId);
    expect(state.lock?.isMine).toBe(false);

    await b.getByRole('button', { name: 'Request control' }).click();
    await expect(b.getByRole('button', { name: 'Control requested' })).toBeDisabled();

    // A gets the prompt on the next heartbeat, makes a last edit, and hands over.
    const prompt = a.getByRole('alertdialog', { name: 'Control requested' });
    await expect(prompt).toBeVisible({ timeout: HEARTBEAT_WAIT });
    await editText(a, SAMPLE.headline, 'Last edit by A');
    await prompt.getByRole('button', { name: 'Hand over' }).click();
    await expect(a.getByTestId('edit-lock').getByText(/is editing$/)).toBeVisible({
      timeout: 15_000,
    });

    // B adopts the lock on its next poll, with A's last edit loaded.
    await expectEditing(b, HEARTBEAT_WAIT);
    await expect(node(b, SAMPLE.headline)).toHaveText('Last edit by A');
    await editText(b, SAMPLE.headline, 'Now B edits');
    await expectSaved(b);

    // A, now locked out, sees B's change once it reloads.
    await a.reload();
    await expectLockedOut(a);
    await expect(node(a, SAMPLE.headline)).toHaveText('Now B edits');
  });

  test('the lock frees when the holder closes the tab', async ({ as, run }) => {
    const a = await as('editor');
    const projectId = await createProject(a, run.org.slug, uniqueName('Lock close'));
    await insertSample(a);

    const b = await as('editor2');
    await openProject(b, run.org.slug, projectId);
    await expectLockedOut(b);

    await a.close({ runBeforeUnload: true }); // pagehide releases the lock (keepalive DELETE)
    await expectEditing(b, HEARTBEAT_WAIT);
    await editText(b, SAMPLE.headline, 'B after A left');
    await expectSaved(b);
  });
});
