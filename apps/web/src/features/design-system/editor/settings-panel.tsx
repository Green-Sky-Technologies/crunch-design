'use client';

import { IssueList, issuesAt, SectionTitle, type PanelProps } from './shared';

export function SettingsPanel({ spec, update, issues }: PanelProps) {
  return (
    <div className="space-y-8">
      <section>
        <SectionTitle>Breakpoints</SectionTitle>
        <div className="card grid grid-cols-2 gap-4 p-4">
          {(['md', 'lg'] as const).map((bp) => (
            <label key={bp} className="block">
              <span className="label">{bp} (min width, px)</span>
              <input
                type="number"
                className="input"
                min={320}
                max={4000}
                value={spec.breakpoints[bp]}
                onChange={(e) => update((d) => void (d.breakpoints[bp] = Number(e.target.value)))}
              />
            </label>
          ))}
          <div className="col-span-2">
            <IssueList issues={issuesAt(issues, 'breakpoints')} />
          </div>
        </div>
      </section>
      <section>
        <SectionTitle>Guidelines</SectionTitle>
        <p className="mb-2 text-sm text-muted">
          Brand voice and do/don&apos;t rules. The agent reads these with the tokens and components.
        </p>
        <textarea
          aria-label="Guidelines"
          className="input min-h-48 font-mono"
          maxLength={20_000}
          value={spec.guidelines}
          onChange={(e) => update((d) => void (d.guidelines = e.target.value))}
        />
        <IssueList issues={issuesAt(issues, 'guidelines')} />
      </section>
    </div>
  );
}
