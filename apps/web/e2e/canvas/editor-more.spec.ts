/**
 * More editor interactions in real layout (Story 3.9 review gaps): absolute placement math,
 * spacing guides, rich paste/drop in inline text editing, and real edit-lock transitions.
 */
import { expect, test } from './fixtures';

test.describe('canvas editor (real layout)', () => {
  test('Alt-drag places a node exactly where it was dropped, including with margins', async ({
    canvas,
    page,
  }) => {
    await canvas.open();
    // give the subhead a margin, which offsetLeft/Top don't include but CSS left/top do
    await page.evaluate(() =>
      window.__cd.store.getState().apply(
        [
          { op: 'setStyle', id: 'n_herobody01', breakpoint: 'base', prop: 'marginLeft', value: 24 },
          { op: 'setStyle', id: 'n_herobody01', breakpoint: 'base', prop: 'marginTop', value: 12 },
        ],
        { source: 'canvas' },
      ),
    );
    await page.waitForTimeout(100);
    const before = await canvas.box('n_herobody01');
    await canvas.click('n_herobody01', { at: 'start' });
    await page.keyboard.down('Alt');
    await page.keyboard.down('Meta'); // no snapping, for exact math
    await canvas.drag(
      { x: before.x + 8, y: before.y + 6 },
      { x: before.x + 108, y: before.y + 46 },
    );
    await page.keyboard.up('Meta');
    await page.keyboard.up('Alt');
    const after = await canvas.box('n_herobody01');
    // moved by exactly the pointer delta on screen (100, 40), at any zoom
    expect(Math.round(after.x - before.x)).toBe(100);
    expect(Math.round(after.y - before.y)).toBe(40);
    const n = (await canvas.doc()).nodes['n_herobody01']!;
    expect(n.positioning).toBe('absolute');
    expect(n.style.base?.left).toBeDefined();
  });

  test('resizing shows spacing guides to the nearest neighbours', async ({ canvas, page }) => {
    await canvas.open();
    await canvas.click('n_herobody01', { at: 'start' });
    const s = await page.locator('[data-handle="s"]').boundingBox();
    await page.mouse.move(s!.x + 4, s!.y + 4);
    await page.mouse.down();
    await page.mouse.move(s!.x + 4, s!.y + 20, { steps: 4 });
    const distances = await page
      .locator('[data-distance]')
      .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-distance'))));
    await page.mouse.up();
    expect(distances.length).toBeGreaterThan(0);
    expect(distances.every((d) => d > 0)).toBe(true);
  });

  test('pasting or dropping rich content into inline text inserts plain text', async ({
    canvas,
    page,
    browserName,
  }) => {
    await canvas.open();
    const t = await canvas.box('n_herotitle1');
    await page.mouse.dblclick(t.x + t.width / 2, t.y + 12);
    await expect.poll(() => canvas.isEditing('n_herotitle1')).toBe(true);
    await page.keyboard.press('ControlOrMeta+a');
    await page.evaluate(() => {
      const el = document
        .querySelector('[data-cd-frame-host]')!
        .shadowRoot!.querySelector<HTMLElement>('[data-cd-id="n_herotitle1"]')!;
      for (const type of ['paste', 'drop'] as const) {
        const dt = new DataTransfer();
        dt.setData('text/plain', type === 'paste' ? 'Pasted' : ' dropped');
        dt.setData('text/html', `<b>${type}</b><script>x()</script>`);
        const ev =
          type === 'paste'
            ? new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
            : new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
      }
    });
    await page.keyboard.press('Enter');
    const text = ((await canvas.doc()).nodes['n_herotitle1'] as { props: { text: string } }).props
      .text;
    // The guarantee, everywhere: only plain text gets in, never the HTML flavour.
    expect(text).not.toMatch(/<|script/);
    expect(text).toContain('dropped');
    // Firefox ignores execCommand('insertText') inside an untrusted (synthetic) paste event; a real
    // user paste is trusted and inserts normally. The default (rich) paste is still prevented.
    if (browserName !== 'firefox') expect(text).toContain('Pasted');
  });

  test('a non-holder requests control, then edits once the holder leaves', async ({
    canvas,
    page,
  }) => {
    await canvas.open('lock=other');
    await expect(page.getByText('Bob Builder is editing')).toBeVisible();
    expect(await page.evaluate(() => window.__cd.store.getState().readOnly)).toBe(true);
    await page.getByRole('button', { name: 'Request control' }).click();
    await expect(page.getByRole('button', { name: 'Control requested' })).toBeVisible();
    expect(await page.evaluate(() => window.__cd.lock.requestedBy())).toBe('user_e2e');

    // Bob's tab closes; the next poll (every 5s while waiting) takes the lock and unlocks editing.
    await page.evaluate(() => window.__cd.lock.otherLeaves());
    await expect(page.getByText('Editing', { exact: true })).toBeVisible({ timeout: 10_000 });
    expect(await page.evaluate(() => window.__cd.lock.holder())).toBe('user_e2e');
    await canvas.click('n_herocta001', { at: 'start' });
    await expect(page.locator('[data-handle]')).not.toHaveCount(0);
  });

  test('an admin can take over a lock held by someone else', async ({ canvas, page }) => {
    await canvas.open('lock=other&role=admin');
    await page.getByRole('button', { name: 'Take over' }).click();
    await expect(page.getByText('Editing', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__cd.store.getState().readOnly)).toBe(false);
  });
});
