// Bundles the plugin main thread (code.ts) and copies the UI. Story 8.1 expands this.
import { build, context } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
await mkdir('dist', { recursive: true });
const opts = {
  entryPoints: ['src/code.ts'],
  bundle: true,
  outfile: 'dist/code.js',
  target: 'es2017',
  format: 'iife',
  logLevel: 'info',
};
if (watch) await (await context(opts)).watch();
else await build(opts);
await copyFile('src/ui.html', 'dist/ui.html');
