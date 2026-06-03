import {
  ANALYTICS_BREAKDOWN_BY,
  ANALYTICS_DAYS,
  REVIEW_SUGGESTION_BREAKDOWN_BY,
  type AnalyticsBreakdownBy,
  type AnalyticsDays,
  type ReviewSuggestionBreakdownBy,
} from "@open-inspect/shared";
import { type AnalyticsFilters, AnalyticsStore, HUMAN_SPAWN_SOURCES } from "../db/analytics-store";
import { ReviewSuggestionStore } from "../db/review-suggestion-store";
import type { Env } from "../types";
import { type RequestContext, type Route, error, json, parsePattern } from "./shared";

function parseDaysParam(value: string | null): AnalyticsDays | null {
  if (value === null) return 30;

  const parsed = Number(value);
  return ANALYTICS_DAYS.includes(parsed as AnalyticsDays) ? (parsed as AnalyticsDays) : null;
}

function parseBreakdownBy(value: string | null): AnalyticsBreakdownBy | null {
  if (!value) return null;
  return ANALYTICS_BREAKDOWN_BY.includes(value as AnalyticsBreakdownBy)
    ? (value as AnalyticsBreakdownBy)
    : null;
}

function getFilters(days: AnalyticsDays): AnalyticsFilters {
  const endAt = Date.now();
  const startAt = endAt - days * 24 * 60 * 60 * 1000;
  return { startAt, endAt, spawnSources: HUMAN_SPAWN_SOURCES };
}

function parseReviewSuggestionBreakdownBy(
  value: string | null
): ReviewSuggestionBreakdownBy | null {
  if (!value) return null;
  return REVIEW_SUGGESTION_BREAKDOWN_BY.includes(value as ReviewSuggestionBreakdownBy)
    ? (value as ReviewSuggestionBreakdownBy)
    : null;
}

async function handleSummary(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const days = parseDaysParam(url.searchParams.get("days"));
  if (!days) {
    return error(`days must be one of: ${ANALYTICS_DAYS.join(", ")}`, 400);
  }

  const store = new AnalyticsStore(env.DB);
  return json(await store.getSummary(getFilters(days)));
}

async function handleTimeseries(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const days = parseDaysParam(url.searchParams.get("days"));
  if (!days) {
    return error(`days must be one of: ${ANALYTICS_DAYS.join(", ")}`, 400);
  }

  const store = new AnalyticsStore(env.DB);
  return json(await store.getTimeseries(getFilters(days)));
}

async function handleBreakdown(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const days = parseDaysParam(url.searchParams.get("days"));
  if (!days) {
    return error(`days must be one of: ${ANALYTICS_DAYS.join(", ")}`, 400);
  }

  const byParam = url.searchParams.get("by");
  const by = parseBreakdownBy(byParam);
  if (!by) {
    return error(`by must be one of: ${ANALYTICS_BREAKDOWN_BY.join(", ")}`, 400);
  }

  const store = new AnalyticsStore(env.DB);
  return json(await store.getBreakdown(getFilters(days), by));
}

async function handleReviewSuggestionsSummary(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const days = parseDaysParam(new URL(request.url).searchParams.get("days"));
  if (!days) {
    return error(`days must be one of: ${ANALYTICS_DAYS.join(", ")}`, 400);
  }
  const store = new ReviewSuggestionStore(env.DB);
  return json(await store.summary(getFilters(days)));
}

async function handleReviewSuggestionsBreakdown(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const days = parseDaysParam(url.searchParams.get("days"));
  if (!days) {
    return error(`days must be one of: ${ANALYTICS_DAYS.join(", ")}`, 400);
  }
  const by = parseReviewSuggestionBreakdownBy(url.searchParams.get("by"));
  if (!by) {
    return error(`by must be one of: ${REVIEW_SUGGESTION_BREAKDOWN_BY.join(", ")}`, 400);
  }
  const store = new ReviewSuggestionStore(env.DB);
  return json(await store.breakdown(getFilters(days), by));
}

async function handleReviewSuggestionsTimeseries(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const days = parseDaysParam(new URL(request.url).searchParams.get("days"));
  if (!days) {
    return error(`days must be one of: ${ANALYTICS_DAYS.join(", ")}`, 400);
  }
  const store = new ReviewSuggestionStore(env.DB);
  return json(await store.timeseries(getFilters(days)));
}

export const analyticsRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/analytics/summary"),
    handler: handleSummary,
  },
  {
    method: "GET",
    pattern: parsePattern("/analytics/timeseries"),
    handler: handleTimeseries,
  },
  {
    method: "GET",
    pattern: parsePattern("/analytics/breakdown"),
    handler: handleBreakdown,
  },
  {
    method: "GET",
    pattern: parsePattern("/analytics/review-suggestions"),
    handler: handleReviewSuggestionsSummary,
  },
  {
    method: "GET",
    pattern: parsePattern("/analytics/review-suggestions/breakdown"),
    handler: handleReviewSuggestionsBreakdown,
  },
  {
    method: "GET",
    pattern: parsePattern("/analytics/review-suggestions/timeseries"),
    handler: handleReviewSuggestionsTimeseries,
  },
];
