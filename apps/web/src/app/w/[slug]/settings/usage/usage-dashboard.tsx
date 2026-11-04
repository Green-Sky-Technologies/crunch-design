/** Usage dashboard (Story 5.10). Server component; numbers come from llm_calls. */
import { formatUsd, type UsageRow, type UsageSummary } from '@/server/services/usage';

const fmt = new Intl.NumberFormat('en-US');
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

function Table({ title, rows }: { title: string; rows: UsageRow[] }) {
  return (
    <section className="mt-8">
      <h3 className="text-sm font-semibold">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No calls yet.</p>
      ) : (
        <div className="card mt-2 overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 text-right font-medium">Calls</th>
                <th className="px-3 py-2 text-right font-medium">Input</th>
                <th className="px-3 py-2 text-right font-medium">Output</th>
                <th className="px-3 py-2 text-right font-medium">Cache read</th>
                <th className="px-3 py-2 text-right font-medium">Cache write</th>
                <th className="px-3 py-2 text-right font-medium">Hit rate</th>
                <th className="px-3 py-2 text-right font-medium">Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-border">
                  <td className="px-3 py-2">{r.label}</td>
                  <td className="px-3 py-2 text-right">{fmt.format(r.calls)}</td>
                  <td className="px-3 py-2 text-right">{fmt.format(r.inputTokens)}</td>
                  <td className="px-3 py-2 text-right">{fmt.format(r.outputTokens)}</td>
                  <td className="px-3 py-2 text-right">{fmt.format(r.cacheReadTokens)}</td>
                  <td className="px-3 py-2 text-right">{fmt.format(r.cacheWriteTokens)}</td>
                  <td className="px-3 py-2 text-right">{pct(r.cacheHitRate)}</td>
                  <td className="px-3 py-2 text-right">{formatUsd(r.costMicros)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function DailyCost({ rows }: { rows: UsageRow[] }) {
  if (!rows.length) return null;
  const max = Math.max(...rows.map((r) => r.costMicros), 1);
  return (
    <section className="mt-8">
      <h3 className="text-sm font-semibold">Estimated cost per day</h3>
      <ul className="card mt-2 flex h-32 items-end gap-1 p-3" aria-label="Estimated cost per day">
        {rows.map((r) => (
          <li
            key={r.key}
            className="flex-1 rounded-t bg-accent/70"
            style={{ height: `${Math.max(2, (r.costMicros / max) * 100)}%` }}
            title={`${r.key}: ${formatUsd(r.costMicros)} · ${fmt.format(r.calls)} calls · ${pct(r.cacheHitRate)} cache hits`}
          />
        ))}
      </ul>
    </section>
  );
}

export function UsageDashboard({ summary }: { summary: UsageSummary }) {
  const t = summary.totals;
  return (
    <div>
      <p className="text-sm text-muted">
        Last {summary.days} days. Costs are estimates from list prices.
      </p>
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Estimated cost"
          value={formatUsd(t.costMicros)}
          hint={`${fmt.format(t.calls)} calls`}
        />
        <Stat
          label="Cache hit rate"
          value={pct(t.cacheHitRate)}
          hint={`${fmt.format(t.cacheReadTokens)} read · ${fmt.format(t.cacheWriteTokens)} written`}
        />
        <Stat
          label="Tokens in / out"
          value={`${fmt.format(t.inputTokens)} / ${fmt.format(t.outputTokens)}`}
        />
        <Stat
          label="Errors"
          value={fmt.format(t.errors)}
          hint={
            t.avgLatencyMs !== null ? `avg latency ${fmt.format(t.avgLatencyMs)} ms` : undefined
          }
        />
      </div>
      {(t.partnerPricedCalls > 0 || t.incompleteCalls > 0) && (
        <ul className="mt-3 space-y-1 text-xs text-muted" data-testid="usage-caveats">
          {t.partnerPricedCalls > 0 && (
            <li>
              {fmt.format(t.partnerPricedCalls)} calls ran on Amazon Bedrock or Google Vertex AI.
              Those providers bill at their own rates; their costs here use Anthropic list prices.
            </li>
          )}
          {t.incompleteCalls > 0 && (
            <li>
              {fmt.format(t.incompleteCalls)} calls ended early (cancelled or disconnected); their
              output tokens are estimated.
            </li>
          )}
        </ul>
      )}
      <DailyCost rows={summary.byDay} />
      <Table title="By member" rows={summary.byMember} />
      <Table title="By model" rows={summary.byModel} />
      <Table title="By task" rows={summary.byTask} />
    </div>
  );
}
