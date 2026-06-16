/**
 * D1 store for posted PR review suggestions.
 *
 * Records one row per inline review comment the bot posts, then marks rows
 * resolved when the corresponding review thread is resolved on GitHub. This is
 * the data behind the reviewer acceptance-rate metric (by repo and model).
 */

import type {
  ReviewSuggestionBreakdownBy,
  ReviewSuggestionsBreakdownResponse,
  ReviewSuggestionsSummaryResponse,
  ReviewSuggestionsTimeseriesResponse,
} from "@open-inspect/shared";

export interface ReviewSuggestionEntry {
  id: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  commentId: number;
  file: string | null;
  line: number | null;
  model: string | null;
  promptVersion: string | null;
  riskScore: string | null;
  status: "open" | "resolved";
  createdAt: number;
  resolvedAt: number | null;
}

export interface AcceptanceRateFilters {
  repoOwner?: string;
  repoName?: string;
  model?: string;
}

export interface AcceptanceRate {
  total: number;
  resolved: number;
  rate: number;
}

interface AcceptanceRow {
  total: number;
  resolved: number;
}

export interface ReviewSuggestionAnalyticsFilters {
  startAt: number;
  endAt: number;
}

interface SummaryRow {
  total: number;
  resolved: number;
  prs_reviewed: number;
}

interface BreakdownRow {
  key: string;
  total: number;
  prs: number;
  resolved: number;
}

interface DayCountRow {
  date: string;
  count: number;
}

export class ReviewSuggestionStore {
  constructor(private readonly db: D1Database) {}

  /**
   * Record a posted suggestion. Idempotent on comment_id (a redelivered webhook
   * for the same comment is ignored).
   */
  async record(entry: ReviewSuggestionEntry): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO review_suggestions
           (id, repo_owner, repo_name, pr_number, comment_id, file, line, model, prompt_version, risk_score, status, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        entry.id,
        entry.repoOwner.toLowerCase(),
        entry.repoName.toLowerCase(),
        entry.prNumber,
        entry.commentId,
        entry.file,
        entry.line,
        entry.model,
        entry.promptVersion,
        entry.riskScore,
        entry.status,
        entry.createdAt,
        entry.resolvedAt
      )
      .run();
  }

  /**
   * Mark the given comment IDs resolved. Only transitions rows still `open`.
   * Returns the number of rows updated.
   */
  async markResolved(commentIds: number[], resolvedAt: number): Promise<number> {
    if (commentIds.length === 0) return 0;
    const placeholders = commentIds.map(() => "?").join(", ");
    const result = await this.db
      .prepare(
        `UPDATE review_suggestions SET status = 'resolved', resolved_at = ?
         WHERE status = 'open' AND comment_id IN (${placeholders})`
      )
      .bind(resolvedAt, ...commentIds)
      .run();
    return result.meta.changes ?? 0;
  }

  /**
   * Acceptance rate (resolved / total) over recorded suggestions, optionally
   * filtered by repo and/or model.
   */
  async acceptanceRate(filters: AcceptanceRateFilters = {}): Promise<AcceptanceRate> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.repoOwner) {
      conditions.push("repo_owner = ?");
      params.push(filters.repoOwner.toLowerCase());
    }
    if (filters.repoName) {
      conditions.push("repo_name = ?");
      params.push(filters.repoName.toLowerCase());
    }
    if (filters.model) {
      conditions.push("model = ?");
      params.push(filters.model);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved
         FROM review_suggestions ${where}`
      )
      .bind(...params)
      .first<AcceptanceRow>();

    const total = row?.total ?? 0;
    const resolved = row?.resolved ?? 0;
    return { total, resolved, rate: total > 0 ? resolved / total : 0 };
  }

  /**
   * Volume summary over a time range (by created_at): total suggestions, distinct
   * PRs reviewed, suggestions per PR, and resolved-thread count (weak proxy).
   */
  async summary(
    filters: ReviewSuggestionAnalyticsFilters
  ): Promise<ReviewSuggestionsSummaryResponse> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
                COUNT(DISTINCT repo_owner || '/' || repo_name || '#' || pr_number) AS prs_reviewed
         FROM review_suggestions
         WHERE created_at >= ? AND created_at < ?`
      )
      .bind(filters.startAt, filters.endAt)
      .first<SummaryRow>();

    const total = row?.total ?? 0;
    const prsReviewed = row?.prs_reviewed ?? 0;
    return {
      total,
      prsReviewed,
      resolved: row?.resolved ?? 0,
      perPr: prsReviewed > 0 ? total / prsReviewed : 0,
    };
  }

  /**
   * Volume breakdown by repo, model, or risk_score over a time range. Missing
   * model/risk_score values fall into an `unknown` bucket.
   */
  async breakdown(
    filters: ReviewSuggestionAnalyticsFilters,
    by: ReviewSuggestionBreakdownBy
  ): Promise<ReviewSuggestionsBreakdownResponse> {
    const groupExpression =
      by === "repo"
        ? "repo_owner || '/' || repo_name"
        : by === "model"
          ? "COALESCE(NULLIF(model, ''), 'unknown')"
          : by === "prompt_version"
            ? "COALESCE(NULLIF(prompt_version, ''), 'unknown')"
            : "COALESCE(NULLIF(risk_score, ''), 'unknown')";

    const result = await this.db
      .prepare(
        `SELECT ${groupExpression} AS key,
                COUNT(*) AS total,
                COUNT(DISTINCT repo_owner || '/' || repo_name || '#' || pr_number) AS prs,
                SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved
         FROM review_suggestions
         WHERE created_at >= ? AND created_at < ?
         GROUP BY key
         ORDER BY total DESC`
      )
      .bind(filters.startAt, filters.endAt)
      .all<BreakdownRow>();

    const entries = (result.results ?? []).map((r) => ({
      key: r.key,
      total: r.total,
      prs: r.prs,
      resolved: r.resolved,
      perPr: r.prs > 0 ? r.total / r.prs : 0,
    }));
    return { entries };
  }

  /**
   * Posted vs resolved per day over a time range. Posted is bucketed by
   * created_at, resolved by resolved_at; the two are merged on date.
   */
  async timeseries(
    filters: ReviewSuggestionAnalyticsFilters
  ): Promise<ReviewSuggestionsTimeseriesResponse> {
    const posted = await this.db
      .prepare(
        `SELECT date(created_at / 1000, 'unixepoch') AS date, COUNT(*) AS count
         FROM review_suggestions
         WHERE created_at >= ? AND created_at < ?
         GROUP BY date`
      )
      .bind(filters.startAt, filters.endAt)
      .all<DayCountRow>();

    const resolved = await this.db
      .prepare(
        `SELECT date(resolved_at / 1000, 'unixepoch') AS date, COUNT(*) AS count
         FROM review_suggestions
         WHERE status = 'resolved' AND resolved_at >= ? AND resolved_at < ?
         GROUP BY date`
      )
      .bind(filters.startAt, filters.endAt)
      .all<DayCountRow>();

    const byDate = new Map<string, { posted: number; resolved: number }>();
    for (const r of posted.results ?? []) {
      byDate.set(r.date, { posted: r.count, resolved: 0 });
    }
    for (const r of resolved.results ?? []) {
      const entry = byDate.get(r.date) ?? { posted: 0, resolved: 0 };
      entry.resolved = r.count;
      byDate.set(r.date, entry);
    }

    const series = [...byDate.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, v]) => ({ date, posted: v.posted, resolved: v.resolved }));
    return { series };
  }
}
