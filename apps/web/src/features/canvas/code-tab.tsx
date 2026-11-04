'use client';

/**
 * Code tab: the selection's generated HTML and CSS, read-only, from the static renderer (the same
 * markup and per-node rules as the canvas and HTML export). Shared token/reset CSS is omitted.
 * Editing code is out of scope: the doc tree is the source of truth (SPEC D1).
 */
import { renderFrameStatic, renderSubtreeStatic } from '@crunch/renderer';
import { useMemo, useState } from 'react';
import { useDocStore, useEditor } from '../doc-store';

const VOID = new Set(['img', 'br', 'hr', 'input', 'meta', 'link']);

/** Indent HTML one element per line (text stays inline with its element). */
export function formatHtml(html: string): string {
  const tokens = html.match(/<[^>]+>|[^<]+/g) ?? [];
  const out: string[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const pad = '  '.repeat(depth);
    if (t.startsWith('</')) {
      depth = Math.max(0, depth - 1);
      out.push('  '.repeat(depth) + t);
    } else if (t.startsWith('<')) {
      const tag = /^<([a-zA-Z0-9-]+)/.exec(t)?.[1]?.toLowerCase() ?? '';
      const text = tokens[i + 1];
      const close = tokens[i + 2];
      // <p>text</p> on one line
      if (text && !text.startsWith('<') && close === `</${tag}>`) {
        out.push(pad + t + text + close);
        i += 2;
      } else if (tag === 'svg') {
        // keep sanitized svg markup on one line
        let j = i + 1;
        let s = t;
        while (j < tokens.length && tokens[j] !== '</svg>') s += tokens[j++];
        out.push(pad + s + (tokens[j] ?? ''));
        i = j;
      } else {
        out.push(pad + t);
        if (!VOID.has(tag) && !t.endsWith('/>')) depth++;
      }
    } else if (t.trim()) out.push(pad + t.trim());
  }
  return out.join('\n');
}

/** One declaration per line, nested blocks indented. */
export function formatCss(css: string): string {
  let out = '';
  let depth = 0;
  const pad = () => '  '.repeat(depth);
  for (const ch of css.replace(/\s*\n\s*/g, '')) {
    if (ch === '{') {
      out = `${out.trimEnd()} {\n`;
      depth++;
      out += pad();
    } else if (ch === ';') {
      out += ';\n' + pad();
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
      out = `${out.trimEnd()}\n${pad()}}\n${pad()}`;
    } else out += ch;
  }
  return out.replace(/\n\s*\n/g, '\n').trim();
}

function CodeBlock({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="space-y-1" aria-label={title}>
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">{title}</h3>
        <button
          type="button"
          className="btn-ghost px-2 py-0.5 text-[11px]"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(
              () => setCopied(true),
              () => setCopied(false),
            );
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied' : `Copy ${title}`}
        </button>
      </div>
      <pre
        data-testid={`code-${title.toLowerCase()}`}
        className="max-h-80 overflow-auto rounded-md bg-surface-2 p-2 font-mono text-[11px] leading-relaxed whitespace-pre"
      >
        {code || '—'}
      </pre>
    </section>
  );
}

export function CodeTab({ nodeId, frameId }: { nodeId?: string; frameId?: string }) {
  const doc = useDocStore((s) => s.doc);
  const { designSystem } = useEditor();
  const code = useMemo(() => {
    try {
      if (nodeId && doc.nodes[nodeId]) {
        const r = renderSubtreeStatic(doc, designSystem.spec, nodeId);
        return { html: formatHtml(r.html), css: formatCss(r.css) };
      }
      if (frameId && doc.frames.some((f) => f.id === frameId)) {
        const r = renderFrameStatic(doc, designSystem.spec, frameId, { annotate: false });
        return { html: formatHtml(r.html), css: formatCss(`${r.frameCss}\n${r.css}`) };
      }
    } catch {
      /* fall through */
    }
    return null;
  }, [doc, designSystem.spec, nodeId, frameId]);
  if (!code)
    return <p className="p-3 text-xs text-muted">Select a layer or a frame to see its code.</p>;
  return (
    <div data-testid="code-tab" className="space-y-3 p-3">
      <CodeBlock title="HTML" code={code.html} />
      <CodeBlock title="CSS" code={code.css} />
      <p className="text-[11px] text-muted">
        Read-only: generated from the design. Design tokens are CSS variables (see Export for the
        full page).
      </p>
    </div>
  );
}
