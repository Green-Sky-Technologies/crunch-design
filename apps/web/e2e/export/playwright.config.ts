/**
 * Visual parity suite for exports (Story 7.1). Needs no app server or database: it renders the
 * canvas renderer in a bundled harness page and the exported HTML side by side.
 *   pnpm --filter @crunch/web exec playwright test -c e2e/export/playwright.config.ts
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  outputDir: '../../test-results/export',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], deviceScaleFactor: 1 } }],
});
