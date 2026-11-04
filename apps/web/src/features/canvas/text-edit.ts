'use client';

/**
 * Inline text editing (Story 3.6). Double-click (or Enter on a selected text node) makes the
 * rendered element itself editable, so text reflows exactly as it will ship. Plain text only:
 * the node's text style is its formatting (no bold/italic/links), pastes are stripped, and rich
 * shortcuts are blocked. IME composition is respected (Enter during composition doesn't commit).
 * Enter or blur commits one op; Shift+Enter inserts a line break; Esc cancels.
 * Text inside a component instance edits the instance prop bound to that part.
 */
import type { DesignSystemSpec, DocOp, Node as DocNode } from '@crunch/doc-model';
import type { DocStore } from '../doc-store';
import type { CanvasStore } from './canvas-store';
import { frameHost, nodeElement } from './dom';

export interface TextTarget {
  frameId: string;
  nodeId: string;
  /** For instance parts: the component part and the instance prop it's bound to. */
  partId?: string;
  bind?: string;
}

/** What text a double-click on a node would edit, if any. */
export function textTargetFor(
  doc: { nodes: Record<string, DocNode> },
  ds: DesignSystemSpec,
  frameId: string,
  nodeId: string,
  partId?: string,
): TextTarget | null {
  const n = doc.nodes[nodeId];
  if (!n || n.locked) return null;
  if (n.type === 'text') return { frameId, nodeId };
  if (n.type === 'instance' && partId) {
    const part = ds.components[n.componentRef.componentId]?.nodes[partId];
    if (part?.type === 'text' && part.bind?.text)
      return { frameId, nodeId, partId, bind: part.bind.text };
  }
  return null;
}

/** Text of an edited element: text nodes plus <br> and block children as line breaks. */
export function readEditedText(el: Node): string {
  let out = '';
  const walk = (n: Node) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) out += (c as Text).data;
      else if (c.nodeName === 'BR') out += '\n';
      else {
        const block = c.nodeName === 'DIV' || c.nodeName === 'P';
        if (block && out && !out.endsWith('\n')) out += '\n';
        walk(c);
      }
    }
  };
  walk(el);
  // Browsers pad editable text with nbsp and trailing breaks; neither is meaningful content.
  return out.replace(/ /g, ' ').replace(/\n+$/, '').slice(0, 20_000);
}

const RICH_KEYS = new Set(['b', 'i', 'u', 'k']);

/** Begin editing. Returns a function that cancels the edit, or null if it can't start. */
export function startTextEdit(
  ctx: { docStore: DocStore; canvas: CanvasStore; viewport: HTMLElement },
  t: TextTarget,
): (() => void) | null {
  const { docStore, canvas } = ctx;
  const s = docStore.getState();
  if (s.readOnly) return null;
  const node = s.doc.nodes[t.nodeId];
  if (!node) return null;
  const target = t.partId
    ? (frameHost(ctx.viewport, t.frameId)?.shadowRoot?.querySelector<HTMLElement>(
        `[data-cd-id="${t.nodeId}"][data-cd-part="${t.partId}"]`,
      ) ?? null)
    : nodeElement(ctx.viewport, t.frameId, t.nodeId);
  if (!target) return null;
  const original =
    node.type === 'text'
      ? node.props.text
      : node.type === 'instance' && t.bind
        ? String(node.props.values[t.bind] ?? target.textContent ?? '')
        : (target.textContent ?? '');

  let composing = false;
  let done = false;

  target.contentEditable = 'plaintext-only';
  if (target.contentEditable !== 'plaintext-only') target.contentEditable = 'true';
  target.style.setProperty('user-select', 'text');
  target.style.setProperty('-webkit-user-select', 'text');
  target.style.setProperty('outline', 'none');
  target.style.setProperty('cursor', 'text');
  target.dataset.cdEditing = '';
  canvas.getState().setGesture('text');
  canvas.getState().setHover(null);

  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    const text = readEditedText(target);
    target.removeEventListener('keydown', onKey);
    target.removeEventListener('keyup', stop);
    target.removeEventListener('keypress', stop);
    target.removeEventListener('paste', onPaste);
    target.removeEventListener('blur', onBlur);
    target.removeEventListener('compositionstart', onCompStart);
    target.removeEventListener('compositionend', onCompEnd);
    target.removeEventListener('pointerdown', stop);
    target.removeAttribute('contenteditable');
    delete target.dataset.cdEditing;
    for (const p of ['user-select', '-webkit-user-select', 'outline', 'cursor'])
      target.style.removeProperty(p);
    // Put back what React rendered before the doc changes, so reconciliation sees its own DOM.
    target.textContent = original;
    window.getSelection()?.removeAllRanges();
    canvas.getState().setGesture(null);
    canvas.getState().bumpLayout();
    if (!commit || text === original) return;
    const op: DocOp =
      t.bind && node.type === 'instance'
        ? { op: 'setInstance', id: t.nodeId, values: { [t.bind]: text } }
        : { op: 'setProps', id: t.nodeId, patch: { text } };
    docStore.getState().apply([op], { source: 'canvas', label: 'Edit text' });
  };

  // Keys stay inside the editor: canvas shortcuts and the shell's undo must not see them.
  const stop = (e: Event) => e.stopPropagation();
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.isComposing || composing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finish(true);
    } else if ((e.metaKey || e.ctrlKey) && RICH_KEYS.has(e.key.toLowerCase())) {
      e.preventDefault(); // formatting is the node's text style
    }
  };
  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain') ?? '';
    // execCommand keeps the browser's own undo stack for the edit session.
    if (!document.execCommand?.('insertText', false, text)) target.textContent += text;
  };
  const onBlur = () => finish(true);
  const onCompStart = () => (composing = true);
  const onCompEnd = () => (composing = false);

  target.addEventListener('keydown', onKey);
  target.addEventListener('keyup', stop);
  target.addEventListener('keypress', stop);
  target.addEventListener('paste', onPaste);
  target.addEventListener('blur', onBlur);
  target.addEventListener('compositionstart', onCompStart);
  target.addEventListener('compositionend', onCompEnd);
  target.addEventListener('pointerdown', stop);

  target.focus({ preventScroll: true });
  try {
    // setBaseAndExtent, not addRange: WebKit ignores ranges added inside a shadow root, which
    // leaves no caret and drops typing.
    const sel = window.getSelection();
    if (sel?.setBaseAndExtent) sel.setBaseAndExtent(target, 0, target, target.childNodes.length);
    else {
      const range = document.createRange();
      range.selectNodeContents(target);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  } catch {
    // Selection inside shadow roots is best-effort in some engines; focus still works.
  }
  return () => finish(false);
}
