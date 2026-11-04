import { defineConfig, devices } from '@playwright/test';

/**
 * Canvas suite (Stories 3.9, 3.10): Chromium, Firefox and WebKit against the self-served canvas
 * harness, so no app server is needed. Run from apps/web:
 *   pnpm exec playwright test -c e2e/canvas/playwright.config.ts
 * The editor specs also run under the app's own playwright.config.ts (testDir ./e2e).
 *
 * The perf budget (perf.spec.ts) runs in its own projects, one worker at a time and after the
 * functional suite, because timing assertions are meaningless on a loaded machine.
 */
const viewport = { width: 1400, height: 860 };
const browsers = [
  { name: 'chromium', device: devices['Desktop Chrome'] },
  { name: 'firefox', device: devices['Desktop Firefox'] },
  { name: 'webkit', device: devices['Desktop Safari'] },
] as const;

export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { trace: 'on-first-retry', viewport },
  projects: [
    ...browsers.map((b) => ({
      name: b.name,
      testIgnore: /perf\.spec\.ts/,
      use: { ...b.device, viewport },
    })),
    ...browsers.map((b, i) => ({
      name: `${b.name}-perf`,
      testMatch: /perf\.spec\.ts/,
      workers: 1,
      // after the functional suites, and one browser at a time
      dependencies: i === 0 ? browsers.map((x) => x.name) : [`${browsers[i - 1]!.name}-perf`],
      use: { ...b.device, viewport },
    })),
  ],
});
