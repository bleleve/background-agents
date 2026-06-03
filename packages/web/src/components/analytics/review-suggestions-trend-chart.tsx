import { useId } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ReviewSuggestionsTimeseriesResponse } from "@open-inspect/shared";
import { formatAnalyticsCount, formatAnalyticsLongDate } from "@/lib/analytics";

interface TrendChartProps {
  series?: ReviewSuggestionsTimeseriesResponse["series"];
  loading: boolean;
}

const SERIES = [
  { key: "posted", label: "Posted", color: "var(--accent)" },
  { key: "resolved", label: "Resolved (proxy)", color: "var(--success)" },
] as const;

export function ReviewSuggestionsTrendChart({ series, loading }: TrendChartProps) {
  const chartIdPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  if (loading && !series) {
    return (
      <div className="rounded-md border border-border-muted bg-card p-5 animate-pulse">
        <div className="h-4 w-40 rounded bg-muted" />
        <div className="mt-6 h-[280px] rounded bg-muted" />
      </div>
    );
  }

  if (!series?.length) {
    return (
      <div className="rounded-md border border-border-muted bg-card p-5">
        <div className="text-lg font-semibold text-foreground">Review Suggestions Over Time</div>
        <p className="mt-1 text-sm text-muted-foreground">No suggestions found for this range.</p>
      </div>
    );
  }

  const data = series.map((p) => ({ ...p, label: p.date.slice(5) }));

  return (
    <div className="rounded-md border border-border-muted bg-card p-5">
      <h2 className="text-lg font-semibold text-foreground">Review Suggestions Over Time</h2>
      <p className="text-sm text-muted-foreground">
        Posted vs. resolved per day. Resolved is a weak proxy — it does not distinguish applied from
        dismissed.
      </p>

      <div className="mt-6 rounded-lg border border-border-muted bg-background p-3 sm:p-4">
        <div className="h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <defs>
                {SERIES.map((s) => (
                  <linearGradient
                    key={s.key}
                    id={`${chartIdPrefix}-${s.key}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="5%" stopColor={s.color} stopOpacity={0.18} />
                    <stop offset="95%" stopColor={s.color} stopOpacity={0.03} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
              />
              <YAxis
                allowDecimals={false}
                axisLine={false}
                tickLine={false}
                tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--popover)",
                  border: "1px solid var(--border)",
                  borderRadius: "6px",
                  color: "var(--popover-foreground)",
                }}
                labelFormatter={(_, payload) => {
                  const rowDate = payload?.[0]?.payload?.date;
                  return typeof rowDate === "string" ? formatAnalyticsLongDate(rowDate) : "";
                }}
                formatter={(value, name) => {
                  const count = typeof value === "number" ? value : Number(value ?? 0);
                  const series = SERIES.find((s) => s.key === String(name));
                  return [formatAnalyticsCount(count), series?.label ?? String(name)];
                }}
              />
              {SERIES.map((s) => (
                <Area
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  stroke={s.color}
                  fill={`url(#${chartIdPrefix}-${s.key})`}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 3 }}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
