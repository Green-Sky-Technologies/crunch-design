// Builds the plugin: bundles the main thread (src/code.ts -> dist/code.js) and the UI
// (src/ui/index.ts, inlined into dist/ui.html, because Figma loads the UI as one HTML string).
import { build, context } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
await mkdir('dist', { recursive: true });

const common = { bundle: true, target: 'es2017', logLevel: 'info', legalComments: 'none' };
const mainOpts = {
  ...common,
  entryPoints: ['src/code.ts'],
  outfile: 'dist/code.js',
  format: 'iife',
};

async function writeUi(js) {
  const html = await readFile('src/ui.html', 'utf8');
  if (!html.includes('/*__UI_BUNDLE__*/')) throw new Error('ui.html is missing the bundle marker');
  const safe = js.replace(/<\/script/gi, '<\\/script');
  await writeFile(
    'dist/ui.html',
    html.replace('/*__UI_BUNDLE__*/', () => safe),
  );
}

const uiOpts = {
  ...common,
  entryPoints: ['src/ui/index.ts'],
  format: 'iife',
  write: false,
  minify: !watch,
  plugins: [
    {
      name: 'inline-ui',
      setup(b) {
        b.onEnd(async (result) => {
          if (result.outputFiles?.[0]) await writeUi(result.outputFiles[0].text);
        });
      },
    },
  ],
};

if (watch) {
  await (await context(mainOpts)).watch();
  await (await context(uiOpts)).watch();
} else {
  await build(mainOpts);
  await build(uiOpts);
}
