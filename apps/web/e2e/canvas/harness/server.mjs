// Builds the canvas harness with esbuild and serves it on a random local port.
// esbuild is a devDependency of @crunch/canvas, so it's resolved from there.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..', '..', '..');
// Outside the repo, so lint/format never see the bundle.
const out = join(tmpdir(), `crunch-canvas-harness-${process.pid}`);
const require = createRequire(join(web, '..', '..', 'packages', 'canvas', 'package.json'));

/** App CSS (Tailwind utilities and chrome tokens) from the last `next build`, if there is one. */
function appCss() {
  const dirs = [join(web, '.next', 'static', 'css'), join(web, '.next', 'static', 'chunks')];
  const css = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (f.endsWith('.css') && statSync(p).isFile()) css.push(readFileSync(p, 'utf8'));
    }
  }
  return css.join('\n');
}

let built;
export function buildHarness() {
  built ??= (async () => {
    const { build } = require('esbuild');
    await mkdir(out, { recursive: true });
    await build({
      entryPoints: [join(here, 'main.tsx')],
      bundle: true,
      format: 'esm',
      minify: true,
      sourcemap: false,
      jsx: 'automatic',
      target: 'es2022',
      outfile: join(out, 'main.js'),
      alias: { '@': join(web, 'src') },
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'error',
    });
    await writeFile(join(out, 'app.css'), appCss());
    await writeFile(
      join(out, 'index.html'),
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Canvas harness</title>' +
        '<link rel="stylesheet" href="/app.css"></head>' +
        '<body style="margin:0;font-family:system-ui,sans-serif"><div id="root"></div>' +
        '<script type="module" src="/main.js"></script></body></html>',
    );
  })();
  return built;
}

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };

export async function startHarness() {
  await buildHarness();
  const server = createServer(async (req, res) => {
    let path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/') path = '/index.html';
    try {
      const body = await readFile(join(out, path.replace(/\.\.+/g, '')));
      res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}
