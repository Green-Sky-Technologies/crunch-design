import type { ReportItem, Severity } from '@crunch/figma-convert/plugin';

/** Adds a plugin-side finding to the mapping report. */
export type Note = (severity: Severity, message: string, subject?: string, nodeId?: string) => void;

export function collector(): { items: ReportItem[]; note: Note } {
  const items: ReportItem[] = [];
  const seen = new Map<string, ReportItem>();
  const note: Note = (severity, message, subject, nodeId) => {
    const key = `${severity}|${subject ?? ''}|${message}`;
    const hit = seen.get(key);
    if (hit) {
      hit.count = (hit.count ?? 1) + 1;
      return;
    }
    const item: ReportItem = { severity, message, count: 1 };
    if (subject) item.subject = subject;
    if (nodeId) item.nodeId = nodeId;
    seen.set(key, item);
    if (items.length < 300) items.push(item);
  };
  return { items, note };
}
