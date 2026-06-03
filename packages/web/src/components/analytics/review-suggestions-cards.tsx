import type { AnalyticsDays, ReviewSuggestionsSummaryResponse } from "@open-inspect/shared";
import { formatAnalyticsCount } from "@/lib/analytics";

interface ReviewSuggestionsCardsProps {
  days: AnalyticsDays;
  summary?: ReviewSuggestionsSummaryResponse;
  loading: boolean;
}

function Card({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="relative overflow-hidden rounded-md border border-border-muted bg-card p-4">
      <div className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,var(--accent),transparent)]" />
      <div className="text-xs uppercase tracking-wider text-secondary-foreground">{label}</div>
      <div className="mt-3 text-2xl font-semibold text-foreground">{value}</div>
      <div className="mt-2 text-sm text-muted-foreground">{hint}</div>
    </div>
  );
}

export function ReviewSuggestionsCards({ days, summary, loading }: ReviewSuggestionsCardsProps) {
  if (loading && !summary) {
    return (
      <div className="grid gap-4 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div
            key={index}
            className="rounded-md border border-border-muted bg-card p-4 animate-pulse"
          >
            <div className="h-3 w-24 rounded bg-muted" />
            <div className="mt-4 h-7 w-20 rounded bg-muted" />
            <div className="mt-3 h-4 w-32 rounded bg-muted" />
          </div>
        ))}
      </div>
    );
  }

  if (!summary) return null;

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card
        label="PRs reviewed"
        value={formatAnalyticsCount(summary.prsReviewed)}
        hint={`Distinct PRs with a suggestion · last ${days} days`}
      />
      <Card
        label="Avg per PR"
        value={summary.perPr.toFixed(1)}
        hint="Noise indicator — lower is better"
      />
      <Card
        label="Resolved"
        value={formatAnalyticsCount(summary.resolved)}
        hint="Threads resolved — proxy, not a quality signal"
      />
    </div>
  );
}
