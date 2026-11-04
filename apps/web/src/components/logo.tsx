export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="2" y="2" width="20" height="20" rx="5" fill="var(--accent)" />
        <path
          d="M7 8h7M7 12h10M7 16h5"
          stroke="var(--accent-ink)"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      </svg>
      {!compact && <span>CrunchDesign</span>}
    </span>
  );
}
