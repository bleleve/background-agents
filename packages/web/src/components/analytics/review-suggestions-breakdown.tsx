import type { ReviewSuggestionsBreakdownResponse } from "@open-inspect/shared";
import { formatAnalyticsCount } from "@/lib/analytics";

interface ReviewSuggestionsBreakdownProps {
  title: string;
  entries?: ReviewSuggestionsBreakdownResponse["entries"];
  loading: boolean;
}

export function ReviewSuggestionsBreakdown({
  title,
  entries,
  loading,
}: ReviewSuggestionsBreakdownProps) {
  if (loading && !entries) {
    return (
      <div className="rounded-md border border-border-muted bg-card p-5 animate-pulse">
        <div className="h-4 w-32 rounded bg-muted" />
        <div className="mt-4 h-32 rounded bg-muted" />
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border-muted bg-card p-5">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {!entries?.length ? (
        <p className="mt-2 text-sm text-muted-foreground">No suggestions in this range.</p>
      ) : (
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wider text-secondary-foreground">
              <th className="py-1 text-left font-medium">Key</th>
              <th className="py-1 text-right font-medium">Total</th>
              <th className="py-1 text-right font-medium">Per PR</th>
              <th className="py-1 text-right font-medium">Resolved</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.key} className="border-t border-border-muted">
                <td className="py-1.5 pr-2 font-mono text-xs text-foreground">{entry.key}</td>
                <td className="py-1.5 text-right tabular-nums text-foreground">
                  {formatAnalyticsCount(entry.total)}
                </td>
                <td className="py-1.5 text-right tabular-nums text-foreground">
                  {entry.perPr.toFixed(1)}
                </td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                  {formatAnalyticsCount(entry.resolved)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
