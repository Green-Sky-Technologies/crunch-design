import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Server modules mark themselves `server-only`; tests run them directly in Node.
      'server-only': fileURLToPath(new URL('./node_modules/server-only/empty.js', import.meta.url)),
    },
  },
  test: {
    // Tests opt in to the deployment AI Gateway explicitly (vi.stubEnv), whatever the shell has.
    env: { CRUNCH_AI_GATEWAY: 'off' },
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**'],
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
  },
});
