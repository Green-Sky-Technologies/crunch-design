/**
 * HTML for the share viewer (Story 6.3). A self-contained page with no app JavaScript: the
 * static renderer's markup plus a tiny CSS-only width switcher (radio inputs + :checked).
 * It deliberately includes nothing but the design (no workspace, project or member data).
 */
import type { DesignDoc, DesignSystemSpec } from '@crunch/doc-model';
import { renderFrameStatic, sharedCss } from '@crunch/renderer';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Response headers for every share-viewer response (success and failure alike). */
export function shareHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'private, no-store',
    'x-robots-tag': 'noindex, nofollow, noarchive',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    // No scripts at all; styles are inline; images may be remote (design assets).
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; font-src https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    ...extra,
  };
}

const CHROME_CSS = `
body{margin:0;background:#eee8d5;font:14px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;color:#586e75}
.cds-bar{position:sticky;top:0;z-index:2147483647;display:flex;gap:4px;align-items:center;padding:8px 16px;background:#fdf6e3;border-bottom:1px solid #e0d9c3}
.cds-bar strong{margin-right:auto;font-weight:600}
.cds-radio{position:absolute;opacity:0;pointer-events:none}
.cds-bar label{cursor:pointer;padding:4px 10px;border-radius:6px;border:1px solid transparent}
#cds-fit:checked~.cds-bar label[for=cds-fit],#cds-sm:checked~.cds-bar label[for=cds-sm],#cds-md:checked~.cds-bar label[for=cds-md],#cds-lg:checked~.cds-bar label[for=cds-lg]{border-color:#e0d9c3;background:#eee8d5}
.cds-main{padding:24px 16px 64px}
.cds-section{margin:0 auto 40px;max-width:100%}
#cds-sm:checked~.cds-main .cds-section{max-width:var(--cds-sm)}
#cds-md:checked~.cds-main .cds-section{max-width:var(--cds-md)}
#cds-lg:checked~.cds-main .cds-section{max-width:var(--cds-lg)}
.cds-label{margin:0 0 8px;font-size:12px;font-weight:500;color:#657b83}
.cds-canvas{background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08);overflow:hidden}
`;

export function renderSharePage(doc: DesignDoc, ds: DesignSystemSpec, frameIds: string[]): string {
  const frames = frameIds.map((id) => ({
    frame: doc.frames.find((f) => f.id === id)!,
    out: renderFrameStatic(doc, ds, id, { annotate: false, showHidden: false, fluid: true }),
  }));
  const shared = sharedCss({ doc, ds, options: { annotate: false, showHidden: false } }).css;
  const widths = `:root{--cds-sm:390px;--cds-md:${ds.breakpoints.md}px;--cds-lg:${Math.max(ds.breakpoints.lg, 1280)}px}`;
  const css = [CHROME_CSS, widths, shared, ...frames.map((f) => `${f.out.frameCss}\n${f.out.css}`)]
    .filter(Boolean)
    .join('\n');
  const title = frames[0]?.frame.name ?? 'Shared design';
  const sections = frames
    .map(
      (f) =>
        `<section class="cds-section"><h2 class="cds-label">${esc(f.frame.name)}</h2><div class="cds-canvas">${f.out.html}</div></section>`,
    )
    .join('\n');
  return (
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<meta name="robots" content="noindex, nofollow, noarchive">\n<meta name="referrer" content="no-referrer">\n` +
    `<title>${esc(title)}</title>\n<style>\n${css}\n</style>\n</head>\n<body>\n` +
    `<input class="cds-radio" type="radio" name="cds-w" id="cds-fit" checked>` +
    `<input class="cds-radio" type="radio" name="cds-w" id="cds-sm">` +
    `<input class="cds-radio" type="radio" name="cds-w" id="cds-md">` +
    `<input class="cds-radio" type="radio" name="cds-w" id="cds-lg">\n` +
    `<div class="cds-bar"><strong>Shared design</strong>` +
    `<label for="cds-fit">Fit</label><label for="cds-sm">Mobile</label>` +
    `<label for="cds-md">Tablet</label><label for="cds-lg">Desktop</label></div>\n` +
    `<main class="cds-main">\n${sections || '<p>This design has no frames yet.</p>'}\n</main>\n</body>\n</html>\n`
  );
}

export function renderShareError(opts: {
  status: 404 | 429;
  signInHref?: string;
  retryAfterSec?: number;
}): string {
  const msg =
    opts.status === 429
      ? `Too many requests. Try again in ${opts.retryAfterSec ?? 60} seconds.`
      : 'This link is invalid, has expired, or is only available to members of a workspace.';
  const signIn = opts.signInHref
    ? `<p><a href="${esc(opts.signInHref)}">Sign in</a> if it was shared with your workspace.</p>`
    : '';
  return (
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex, nofollow"><title>Link unavailable</title>` +
    `<style>body{margin:0;display:grid;place-items:center;min-height:100vh;font:15px/1.5 system-ui,sans-serif;background:#fdf6e3;color:#586e75}main{max-width:28rem;padding:24px;text-align:center}a{color:#cb4b16}</style>` +
    `</head><body><main><h1 style="font-size:18px">Link unavailable</h1><p>${esc(msg)}</p>${signIn}</main></body></html>\n`
  );
}
