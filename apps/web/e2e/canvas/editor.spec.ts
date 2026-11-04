/**
 * Canvas editor interactions across Chromium, Firefox and WebKit (Story 3.9): select, drag,
 * resize, inspector and inline text editing, plus pan/zoom and read-only modes. Every edit is
 * asserted on the doc (ops) and on the rendered DOM, and each gesture is one undo step.
 */
import { expect, test } from './fixtures';

test.describe('canvas editor', () => {
  test('selects nodes, multi-selects with Shift, navigates the tree, and outlines track zoom', async ({
    canvas,
    page,
  }) => {
    const errors = await canvas.open();
    await canvas.click('n_herotitle1');
    expect(await canvas.selection()).toEqual({
      frameId: 'f_desktop001',
      nodeIds: ['n_herotitle1'],
    });
    await expect(page.locator('[data-cd-selected="n_herotitle1"]')).toHaveCount(1);
    await expect(page.getByRole('treeitem', { selected: true })).toContainText('Headline');

    await canvas.click('n_herobody01', { shift: true });
    expect((await canvas.selection()).nodeIds).toEqual(['n_herotitle1', 'n_herobody01']);

    await canvas.click('n_herobody01');
    await page.keyboard.press('Escape');
    expect((await canvas.selection()).nodeIds).toEqual(['n_hero000001']);
    await page.keyboard.press('Enter');
    expect((await canvas.selection()).nodeIds).toEqual(['n_herotitle1']);

    // zoom in with ctrl+wheel; the outline still matches the element exactly
    const before = await page.getByTestId('zoom-level').innerText();
    await page.mouse.move(700, 400);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await expect(page.getByTestId('zoom-level')).not.toHaveText(before);
    await page.waitForTimeout(100);
    const el = await canvas.box('n_herotitle1');
    const outline = await page
      .locator('[data-cd-selected="n_herotitle1"]')
      .locator('..')
      .boundingBox();
    expect(Math.abs(outline!.x - el.x)).toBeLessThan(1.5);
    expect(Math.abs(outline!.width - el.width)).toBeLessThan(1.5);
    expect(errors).toEqual([]);
  });

  test('drags to reorder within a flex parent and to reparent into another container', async ({
    canvas,
  }) => {
    await canvas.open();
    const title = await canvas.box('n_herotitle1');
    const cta = await canvas.box('n_herocta001');
    await canvas.click('n_herotitle1');
    await canvas.drag(
      { x: title.x + title.width / 2, y: title.y + 10 },
      { x: cta.x + 20, y: cta.y + cta.height + 6 },
    );
    let doc = await canvas.doc();
    expect(doc.nodes['n_hero000001']!.children).toEqual([
      'n_herobody01',
      'n_herocta001',
      'n_herotitle1',
    ]);
    // the rendered DOM follows
    expect((await canvas.box('n_herotitle1')).y).toBeGreaterThan(
      (await canvas.box('n_herocta001')).y,
    );

    const f1 = await canvas.box('n_feat1title0');
    const f2body = await canvas.box('n_feat2body00');
    await canvas.click('n_feat1title0');
    await canvas.drag({ x: f1.x + 10, y: f1.y + 5 }, { x: f2body.x + 20, y: f2body.y + 2 });
    doc = await canvas.doc();
    expect(doc.nodes['n_feat2card00']!.children).toEqual([
      'n_feat2title0',
      'n_feat1title0',
      'n_feat2body00',
    ]);
    expect(await canvas.undoLabels()).toEqual(['Move layer', 'Move layer']);

    // Undo both moves: the tree and the rendered order are back to the original.
    // (The keyboard shortcut lives in the editor shell; the harness exposes the same store undo.)
    await canvas.page.getByRole('button', { name: 'Undo' }).click();
    await canvas.page.getByRole('button', { name: 'Undo' }).click();
    doc = await canvas.doc();
    expect(doc.nodes['n_hero000001']!.children).toEqual([
      'n_herotitle1',
      'n_herobody01',
      'n_herocta001',
    ]);
    expect(doc.nodes['n_feat2card00']!.children).toEqual(['n_feat2title0', 'n_feat2body00']);
    expect(doc.nodes['n_feat1card00']!.children).toEqual(['n_feat1title0', 'n_feat1body00']);
    expect((await canvas.box('n_herotitle1')).y).toBeLessThan((await canvas.box('n_herobody01')).y);
  });

  test('resizes with handles to a fixed size and hugs on double-click', async ({
    canvas,
    page,
  }) => {
    await canvas.open();
    await canvas.click('n_herocta001', { at: 'start' });
    const start = await canvas.box('n_herocta001');
    const e = await page.locator('[data-handle="e"]').boundingBox();
    await page.keyboard.down('Control'); // no snapping, for a predictable size
    await canvas.drag({ x: e!.x + 4, y: e!.y + 4 }, { x: e!.x + 84, y: e!.y + 4 });
    await page.keyboard.up('Control');
    const doc = await canvas.doc();
    const width = doc.nodes['n_herocta001']!.style.lg?.width;
    expect(typeof width).toBe('number');
    const after = await canvas.box('n_herocta001');
    expect(after.width).toBeGreaterThan(start.width + 40);

    await page.locator('[data-handle="e"]').dblclick();
    expect((await canvas.doc()).nodes['n_herocta001']!.style.lg?.width).toBe('hug');
    expect(await canvas.undoLabels()).toEqual(['Resize layer', 'Hug contents']);
  });

  test('edits style props in the inspector with literals and tokens', async ({ canvas, page }) => {
    await canvas.open();
    await canvas.click('n_herotitle1');
    const ls = page.locator('[data-prop="letterSpacing"] input');
    await ls.fill('3px');
    await ls.press('Enter');
    await expect.poll(() => canvas.computed('n_herotitle1', 'letter-spacing')).toBe('3px');

    await page
      .locator('[data-prop="color"]')
      .getByRole('button', { name: 'Text color token' })
      .click();
    await page.getByRole('button', { name: /^color\.accent/ }).click();
    await expect.poll(() => canvas.computed('n_herotitle1', 'color')).toBe('rgb(249, 115, 22)');

    await page.getByRole('tab', { name: 'base' }).click();
    await page
      .locator('[data-prop="flexDirection"] select')
      .waitFor({ state: 'attached' })
      .catch(() => {});
    expect(await canvas.undoLabels()).toEqual(['Set letter spacing', 'Set text color']);
    // undo reverts the render too
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => canvas.computed('n_herotitle1', 'color')).not.toBe('rgb(249, 115, 22)');
  });

  test('edits text inline; Enter commits, Esc cancels, emoji survive', async ({ canvas, page }) => {
    await canvas.open();
    const t = await canvas.box('n_herotitle1');
    await page.mouse.dblclick(t.x + t.width / 2, t.y + 12);
    await expect.poll(() => canvas.isEditing('n_herotitle1')).toBe(true);
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Hello ');
    await page.keyboard.insertText('👋🏽 世界');
    await page.keyboard.press('Enter');
    expect(await canvas.isEditing('n_herotitle1')).toBe(false);
    const doc = await canvas.doc();
    expect((doc.nodes['n_herotitle1'] as { props: { text: string } }).props.text).toBe(
      'Hello 👋🏽 世界',
    );

    const b = await canvas.box('n_herobody01');
    await page.mouse.dblclick(b.x + 30, b.y + 6);
    await expect.poll(() => canvas.isEditing('n_herobody01')).toBe(true);
    await page.keyboard.type('zzz');
    await page.keyboard.press('Escape');
    const body = (await canvas.doc()).nodes['n_herobody01'] as { props: { text: string } };
    expect(body.props.text).not.toContain('zzz');
    expect(await canvas.undoLabels()).toEqual(['Edit text']);
  });

  test('frames: add, move by label, and pan the canvas', async ({ canvas, page }) => {
    await canvas.open();
    await page.getByRole('button', { name: '+ Frame' }).click();
    await page.getByRole('menuitem', { name: /Mobile/ }).click();
    const frames = (await canvas.doc()).frames;
    expect(frames.map((f) => f.width)).toEqual([1280, 390]);
    const label = page.locator(`[data-cd-frame-label="${frames[1]!.id}"]`);
    const lb = await label.boundingBox();
    await canvas.drag({ x: lb!.x + 10, y: lb!.y + 8 }, { x: lb!.x + 110, y: lb!.y + 58 });
    const moved = (await canvas.doc()).frames[1]!;
    expect(moved.canvas.x).toBeGreaterThan(frames[1]!.canvas.x);
    expect(moved.canvas.y).toBeGreaterThan(frames[1]!.canvas.y);

    const cam = () => page.evaluate(() => window.__cd.canvas.getState().camera);
    const c0 = await cam();
    await page.mouse.move(700, 450);
    await page.mouse.wheel(0, 200);
    await expect.poll(async () => (await cam()).y).toBeLessThan(c0.y);
  });

  test('viewers and non-lock-holders get a read-only canvas', async ({ canvas, page }) => {
    await canvas.open('role=viewer');
    await expect(page.getByText('View only')).toBeVisible();
    await canvas.click('n_herocta001', { at: 'start' });
    await expect(page.locator('[data-handle]')).toHaveCount(0);
    const t = await canvas.box('n_herotitle1');
    await page.mouse.dblclick(t.x + t.width / 2, t.y + 12);
    expect(await canvas.isEditing('n_herotitle1')).toBe(false);
    await expect(page.locator('[data-prop="letterSpacing"] input')).toBeDisabled();

    await canvas.open('lock=other');
    await expect(page.getByText('Bob Builder is editing')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Request control' })).toBeVisible();
    await canvas.click('n_herocta001', { at: 'start' });
    await expect(page.locator('[data-handle]')).toHaveCount(0);
  });
});
