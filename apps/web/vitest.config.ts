import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**'],
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
  },
});
