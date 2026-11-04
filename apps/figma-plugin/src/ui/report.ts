/** Renders a mapping / fidelity report. */
import type { ReportItem } from '@crunch/figma-convert/plugin';
import { h } from './dom';

export function reportView(items: ReportItem[], title = 'Mapping report'): HTMLElement {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of items) counts[i.severity] += i.count ?? 1;
  return h(
    'div',
    { class: 'stack' },
    h(
      'h3',
      {},
      `${title} `,
      h(
        'span',
        { class: 'muted small' },
        `${counts.error} errors · ${counts.warning} warnings · ${counts.info} notes`,
      ),
    ),
    items.length
      ? h(
          'ul',
          { class: 'report' },
          items.map((i) =>
            h(
              'li',
              { class: `sev-${i.severity}` },
              `${i.severity === 'error' ? '✕' : i.severity === 'warning' ? '!' : '·'} ${i.message}`,
              i.subject ? h('code', {}, ` ${i.subject}`) : null,
              i.nodeName ? h('span', { class: 'muted' }, ` — ${i.nodeName}`) : null,
              (i.count ?? 1) > 1 ? h('span', { class: 'muted' }, ` ×${i.count}`) : null,
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'Everything was represented.'),
  );
}
