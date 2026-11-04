import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3100);

/**
 * App-level e2e against `next start` (signed-out flows and, once configured, real Clerk sign-in).
 * The canvas and export suites run self-contained harnesses with their own configs:
 *   pnpm e2e:canvas   (e2e/canvas/playwright.config.ts)
 *   pnpm e2e:export   (e2e/export/playwright.config.ts)
 */
export default defineConfig({
  testDir: './e2e',
  testIgnore: ['canvas/**', 'export/**'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'on-first-retry' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: `pnpm start --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
