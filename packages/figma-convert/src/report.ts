/** Mapping / fidelity report builder: deduplicates repeated findings and caps the size. */
import type { ReportItem, Severity } from './plan';

export const MAX_REPORT_ITEMS = 300;

export class Reporter {
  private items = new Map<string, ReportItem>();

  add(
    severity: Severity,
    message: string,
    at: { nodeId?: string; nodeName?: string; subject?: string } = {},
  ) {
    const key = `${severity}|${at.subject ?? ''}|${message}`;
    const existing = this.items.get(key);
    if (existing) {
      existing.count = (existing.count ?? 1) + 1;
      return;
    }
    if (this.items.size >= MAX_REPORT_ITEMS) return;
    this.items.set(key, { severity, message, ...at, count: 1 });
  }

  info(message: string, at?: Parameters<Reporter['add']>[2]) {
    this.add('info', message, at);
  }
  warn(message: string, at?: Parameters<Reporter['add']>[2]) {
    this.add('warning', message, at);
  }
  error(message: string, at?: Parameters<Reporter['add']>[2]) {
    this.add('error', message, at);
  }

  list(): ReportItem[] {
    const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
    return [...this.items.values()].sort((a, b) => rank[a.severity] - rank[b.severity]);
  }
}
