/** Tiny DOM helpers for the plugin UI (no framework, to keep the bundle small). */

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | boolean | number | EventListener | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'class') {
      el.className = String(v);
    } else if (k === 'value' && 'value' in el) {
      (el as HTMLInputElement).value = String(v);
    } else if (k === 'checked' && 'checked' in el) {
      (el as HTMLInputElement).checked = Boolean(v);
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function mount(root: HTMLElement, ...nodes: (Node | null)[]) {
  root.replaceChildren(...nodes.filter((n): n is Node => n !== null));
}
