/**
 * Serialize the current selection for import (Story 8.3): REST-shaped nodes, SVG exports for
 * vectors/icons, image fills as base64 data URLs, and the names of bound variables.
 */
import { pluginNodeToRest } from '@crunch/figma-convert/plugin';
import type { SelectionPayload } from '../shared/messages';

const MAX_ROOTS = 20;
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_SVG_CHARS = 200_000;
const VECTOR_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'LINE', 'POLYGON']);

function isIcon(n: SceneNode): boolean {
  if (VECTOR_TYPES.has(n.type)) return true;
  if (
    (n.type === 'GROUP' || n.type === 'FRAME' || n.type === 'INSTANCE') &&
    'children' in n &&
    n.children.length
  ) {
    return (
      n.width <= 128 &&
      n.height <= 128 &&
      n.children.every((c) => VECTOR_TYPES.has(c.type) || isIcon(c))
    );
  }
  return false;
}

function mime(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  return null;
}

export async function serializeSelection(): Promise<SelectionPayload> {
  const sel = figma.currentPage.selection.slice(0, MAX_ROOTS);
  if (!sel.length) throw new Error('Select one or more frames to import');
  const limits = { maxNodes: 5000, count: 0 };
  const nodes = sel.map((n) => pluginNodeToRest(n, figma.mixed, limits));

  const svgs: Record<string, string> = {};
  const hashes = new Set<string>();
  const varIds = new Set<string>();
  const skipped: string[] = [];

  const visit = async (n: SceneNode, root: boolean) => {
    const bv = (n as { boundVariables?: Record<string, unknown> }).boundVariables ?? {};
    for (const v of Object.values(bv))
      for (const a of Array.isArray(v) ? v : [v])
        if (a && typeof a === 'object' && 'id' in a) varIds.add(String((a as { id: string }).id));
    const fills = 'fills' in n && n.fills !== figma.mixed ? (n.fills as readonly Paint[]) : [];
    for (const f of fills) {
      if (f.type === 'IMAGE' && f.imageHash && f.visible !== false) hashes.add(f.imageHash);
      if (f.type === 'SOLID' && f.boundVariables?.color) varIds.add(f.boundVariables.color.id);
    }
    if (!root && n.visible && isIcon(n)) {
      try {
        const svg = await n.exportAsync({ format: 'SVG_STRING' });
        if (svg.length <= MAX_SVG_CHARS) svgs[n.id] = svg;
        else skipped.push(`${n.name}: SVG too large`);
      } catch {
        skipped.push(`${n.name}: SVG export failed`);
      }
      return;
    }
    if ('children' in n) for (const c of n.children) await visit(c, false);
  };
  for (const n of sel) await visit(n, true);

  const images: Record<string, string> = {};
  let total = 0;
  for (const hash of hashes) {
    const img = figma.getImageByHash(hash);
    if (!img) continue;
    const bytes = await img.getBytesAsync();
    const type = mime(bytes);
    if (!type || bytes.length > MAX_IMAGE_BYTES || total + bytes.length > MAX_TOTAL_IMAGE_BYTES) {
      skipped.push(`image ${hash.slice(0, 8)}: ${type ? 'too large' : 'unsupported format'}`);
      continue;
    }
    total += bytes.length;
    images[hash] = `data:${type};base64,${figma.base64Encode(bytes)}`;
  }

  const variables: Record<string, string> = {};
  for (const id of varIds) {
    const v = await figma.variables.getVariableByIdAsync(id);
    if (v) variables[id] = v.name;
  }
  return { nodes, svgs, images, variables, skipped };
}
