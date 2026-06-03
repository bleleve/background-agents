import { buildControlPlanePath } from "./control-plane-query";

export function buildAnalyticsSummaryPath(searchParams: URLSearchParams): string {
  return buildControlPlanePath("/analytics/summary", searchParams, ["days"]);
}

export function buildAnalyticsTimeseriesPath(searchParams: URLSearchParams): string {
  return buildControlPlanePath("/analytics/timeseries", searchParams, ["days"]);
}

export function buildAnalyticsBreakdownPath(searchParams: URLSearchParams): string {
  return buildControlPlanePath("/analytics/breakdown", searchParams, ["days", "by"]);
}

export function buildReviewSuggestionsSummaryPath(searchParams: URLSearchParams): string {
  return buildControlPlanePath("/analytics/review-suggestions", searchParams, ["days"]);
}

export function buildReviewSuggestionsBreakdownPath(searchParams: URLSearchParams): string {
  return buildControlPlanePath("/analytics/review-suggestions/breakdown", searchParams, [
    "days",
    "by",
  ]);
}

export function buildReviewSuggestionsTimeseriesPath(searchParams: URLSearchParams): string {
  return buildControlPlanePath("/analytics/review-suggestions/timeseries", searchParams, ["days"]);
}
