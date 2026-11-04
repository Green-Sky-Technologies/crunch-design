import { defineConfig, devices } from '@playwright/test';

/**
 * Canvas suite (Stories 3.9, 3.10): Chromium, Firefox and WebKit against the self-served canvas
 * harness, so no app server is needed. Run from apps/web:
 *   pnpm exec playwright test -c e2e/canvas/playwright.config.ts
 * The specs also run under the app's own playwright.config.ts (testDir ./e2e).
 */
export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { trace: 'on-first-retry', viewport: { width: 1400, height: 860 } },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 860 } },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], viewport: { width: 1400, height: 860 } },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], viewport: { width: 1400, height: 860 } },
    },
  ],
});
