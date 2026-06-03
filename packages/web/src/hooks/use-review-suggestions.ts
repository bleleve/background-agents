import { useSession } from "next-auth/react";
import useSWR from "swr";
import type {
  AnalyticsDays,
  ReviewSuggestionsBreakdownResponse,
  ReviewSuggestionsSummaryResponse,
  ReviewSuggestionsTimeseriesResponse,
} from "@open-inspect/shared";
import { ANALYTICS_REFRESH_INTERVAL_MS } from "@/lib/analytics";

export function useReviewSuggestionAnalytics(days: AnalyticsDays) {
  const { data: session } = useSession();
  // Poll on the shared interval, but keep the last data during revalidation and
  // don't fast-retry on error — otherwise the section flickers (e.g. while the
  // backend routes aren't deployed yet, the failing fetches would retry on a tight
  // loop and repaint the cards every few seconds).
  const swrOptions = {
    refreshInterval: ANALYTICS_REFRESH_INTERVAL_MS,
    revalidateOnFocus: false,
    shouldRetryOnError: false,
    keepPreviousData: true,
  } as const;

  const summary = useSWR<ReviewSuggestionsSummaryResponse>(
    session ? `/api/analytics/review-suggestions?days=${days}` : null,
    swrOptions
  );

  const repos = useSWR<ReviewSuggestionsBreakdownResponse>(
    session ? `/api/analytics/review-suggestions/breakdown?days=${days}&by=repo` : null,
    swrOptions
  );

  const models = useSWR<ReviewSuggestionsBreakdownResponse>(
    session ? `/api/analytics/review-suggestions/breakdown?days=${days}&by=model` : null,
    swrOptions
  );

  const riskScores = useSWR<ReviewSuggestionsBreakdownResponse>(
    session ? `/api/analytics/review-suggestions/breakdown?days=${days}&by=risk_score` : null,
    swrOptions
  );

  const timeseries = useSWR<ReviewSuggestionsTimeseriesResponse>(
    session ? `/api/analytics/review-suggestions/timeseries?days=${days}` : null,
    swrOptions
  );

  return {
    summary: summary.data,
    repoBreakdown: repos.data,
    modelBreakdown: models.data,
    riskScoreBreakdown: riskScores.data,
    timeseries: timeseries.data,
    loading:
      (!summary.data && summary.isLoading) ||
      (!repos.data && repos.isLoading) ||
      (!models.data && models.isLoading) ||
      (!riskScores.data && riskScores.isLoading) ||
      (!timeseries.data && timeseries.isLoading),
    error: summary.error ?? repos.error ?? models.error ?? riskScores.error ?? timeseries.error,
  };
}
