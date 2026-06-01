/**
 * D1 store for posted PR review suggestions.
 *
 * Records one row per inline review comment the bot posts, then marks rows
 * resolved when the corresponding review thread is resolved on GitHub. This is
 * the data behind the reviewer acceptance-rate metric (by repo and model).
 */

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

export class ReviewSuggestionStore {
  constructor(private readonly db: D1Database) {}

  /**
   * Record a posted suggestion. Idempotent on comment_id (a redelivered webhook
   * for the same comment is ignored).
   */
  async record(entry: ReviewSuggestionEntry): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO review_suggestions (id, repo_owner, repo_name, pr_number, comment_id, file, line, model, prompt_version, risk_score, status, created_at, resolved_at)
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
}
