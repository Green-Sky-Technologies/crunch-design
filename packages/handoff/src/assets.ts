/**
 * Image handling for offline exports. Image sources are collected from the doc (image nodes and
 * instance prop values), optionally fetched by a caller-supplied fetcher (the server restricts it
 * to our own asset storage), and rewritten to relative paths inside the ZIP.
 */
import type { DesignDoc } from '@crunch/doc-model';

export interface FetchedAsset {
  bytes: Uint8Array;
  contentType: string;
}
/** Return the asset bytes, or null to leave the source as-is (remote reference). */
export type AssetFetcher = (src: string) => Promise<FetchedAsset | null>;

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
};

export function extensionFor(contentType: string): string | null {
  return EXT[contentType.split(';')[0]!.trim().toLowerCase()] ?? null;
}

const isRemote = (s: string) => /^https:\/\//.test(s);

/** Distinct remote (https) image sources used by the given frames' nodes. */
export function collectImageSources(doc: DesignDoc, nodeIds?: Iterable<string>): string[] {
  const out = new Set<string>();
  const ids = nodeIds ? [...nodeIds] : Object.keys(doc.nodes);
  for (const id of ids) {
    const n = doc.nodes[id];
    if (!n) continue;
    if (n.type === 'image' && isRemote(n.props.src)) out.add(n.props.src);
    if (n.type === 'instance')
      for (const v of Object.values(n.props.values))
        if (typeof v === 'string' && isRemote(v)) out.add(v);
  }
  return [...out].sort();
}

/** A copy of the doc with image sources replaced per `map` (others untouched). */
export function rewriteImageSources(doc: DesignDoc, map: Map<string, string>): DesignDoc {
  if (!map.size) return doc;
  const nodes = { ...doc.nodes };
  for (const [id, n] of Object.entries(doc.nodes)) {
    if (n.type === 'image' && map.has(n.props.src))
      nodes[id] = { ...n, props: { ...n.props, src: map.get(n.props.src)! } };
    else if (n.type === 'instance') {
      let changed = false;
      const values = { ...n.props.values };
      for (const [k, v] of Object.entries(values))
        if (typeof v === 'string' && map.has(v)) {
          values[k] = map.get(v)!;
          changed = true;
        }
      if (changed) nodes[id] = { ...n, props: { ...n.props, values } };
    }
  }
  return { ...doc, nodes };
}

/** Node ids in the subtrees of the given frames. */
export function frameNodeIds(doc: DesignDoc, frameIds: string[]): Set<string> {
  const out = new Set<string>();
  for (const fid of frameIds) {
    const f = doc.frames.find((x) => x.id === fid);
    if (!f) continue;
    const stack = [f.rootNodeId];
    while (stack.length) {
      const id = stack.pop()!;
      const n = doc.nodes[id];
      if (!n || out.has(id)) continue;
      out.add(id);
      stack.push(...n.children);
    }
  }
  return out;
}
