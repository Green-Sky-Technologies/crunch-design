import { expect, test } from '@playwright/test';

test('landing page renders for signed-out visitors', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Describe it');
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
});

test('workspace routes send signed-out visitors to sign-in', async ({ page }) => {
  await page.goto('/w/some-workspace');
  await expect(page).toHaveURL(/\/sign-in/);
});

test('unsigned webhooks are rejected', async ({ request }) => {
  const res = await request.post('/api/webhooks/clerk', { data: {} });
  expect(res.status()).toBe(400);
});
