/**
 * D1-backed atomic claim/confirm/release protocol for per-PR session
 * coalescing (github-bot's request and review lanes).
 *
 * Why this exists: two genuinely concurrent webhook deliveries for the same
 * PR (e.g. two @mentions landing in the same second) must never both create a
 * session and race to push the same branch. The prior implementation used a
 * Cloudflare KV pointer (`request-session:<repo>:<pr>` / `review-session:...`)
 * — but KV is eventually consistent (writes can take up to ~60s to
 * propagate), so a read-then-write against KV is not atomic: both concurrent
 * deliveries can read "no pointer" and both proceed. D1 gives us a real
 * atomic primitive (`INSERT ... ON CONFLICT`), so this store makes D1 the
 * single source of truth for "who owns this PR's session slot right now."
 *
 * One row per (repo_full_name, pr_number, lane) — `lane` is `'review'` or
 * `'request'`, matching github-bot's two coalescing mechanisms. The protocol:
 *
 * 1. **claim()** — the caller generates a random `claimToken` and attempts
 *    `INSERT ... ON CONFLICT (repo_full_name, pr_number, lane) DO NOTHING`.
 *    If the row now carries our token, we won the slot (`{ result: "claimed"
 *    }`) and are responsible for creating the session and calling confirm().
 *    If we lost, the existing row is returned (`{ result: "existing",
 *    sessionId, status, claimToken }`) — `claimToken` here is the *owning*
 *    claimer's token (not ours), needed by release() below. A `status:
 *    "creating"` row with no `sessionId` means someone else's claim/confirm
 *    is still in flight; if it's older than {@link STALE_CLAIM_THRESHOLD_MS}
 *    (its claimer likely crashed between claim and confirm), claim()
 *    attempts to steal it via a conditional `UPDATE ... WHERE claim_token =
 *    <old> AND updated_at < ?` and re-checks ownership before returning.
 *
 * 2. **confirm()** — the winning claimer calls this once the session actually
 *    exists, writing `session_id` and flipping `status` to `'active'`. The
 *    `WHERE claim_token = ?` guard means a stale/lost claimer whose slot was
 *    already stolen can never clobber the new owner's row.
 *
 * 3. **release()** — frees a slot whose *session* (not just its claim) has
 *    gone dead — e.g. the request lane's liveness check finds the confirmed
 *    session is terminal. Requires the row's current `claim_token`, which is
 *    why claim()'s "existing" result carries it: the discoverer didn't win
 *    the claim, so it doesn't already know that token. `DELETE ... WHERE
 *    claim_token = ?` makes this safe even if the row changed underneath the
 *    caller (e.g. already released/reclaimed by someone else) — it's just a
 *    no-op in that case.
 *
 * The review lane never calls release(): review sessions are read-only and
 * short-lived by nature, so there is nothing to evict (they're only ever
 * reused-if-live or superseded through the separate "supersede on retry"
 * mechanism). Callers still guard the create-vs-reuse race via claim/confirm.
 *
 * 4. **peek()** — a plain read, no claim, no side effects. For callers that
 *    only need "is there a confirmed session" (relaying a PR state change,
 *    resolving a branch for a preview) without risking taking ownership of an
 *    unclaimed slot the way claim() would.
 */

export type PrSessionLane = "review" | "request";
export type PrSessionStatus = "creating" | "active";

export type PrSessionClaimOutcome =
  | { result: "claimed" }
  | {
      result: "existing";
      sessionId: string | null;
      status: PrSessionStatus;
      /** The owning claimer's token — pass through to release() to evict a dead session. */
      claimToken: string;
    };

/**
 * How long a `'creating'` claim may sit unconfirmed before another caller may
 * steal it. Covers a claimer that crashed (or the Worker was evicted)
 * between winning the claim and calling confirm(). Session creation is a
 * single internal fetch; 30s is generous headroom above normal latency while
 * still recovering quickly from a crash.
 */
export const STALE_CLAIM_THRESHOLD_MS = 30_000;

interface PrActiveSessionRow {
  session_id: string | null;
  status: PrSessionStatus;
  claim_token: string;
  updated_at: number;
}

export class PrActiveSessionStore {
  constructor(private readonly db: D1Database) {}

  /**
   * Read-only lookup — no claim, no side effects. Used by callers that only
   * need "is there a confirmed session for this PR/lane" (e.g. relaying a PR
   * state change, or dispatching a preview) and must never take ownership of
   * an unclaimed slot the way claim() would. Returns `sessionId: null` both
   * when no row exists and when a claim is still `'creating'` (unconfirmed) —
   * either way there is no session yet to act on.
   */
  async peek(
    repoFullName: string,
    prNumber: number,
    lane: PrSessionLane
  ): Promise<{ sessionId: string | null; status: PrSessionStatus } | null> {
    const row = await this.getRow(repoFullName.toLowerCase(), prNumber, lane);
    if (!row) return null;
    return { sessionId: row.session_id, status: row.status };
  }

  private prepareGetRow(
    repoFullName: string,
    prNumber: number,
    lane: PrSessionLane
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `SELECT session_id, status, claim_token, updated_at
         FROM pr_active_sessions
         WHERE repo_full_name = ? AND pr_number = ? AND lane = ?`
      )
      .bind(repoFullName, prNumber, lane);
  }

  private async getRow(
    repoFullName: string,
    prNumber: number,
    lane: PrSessionLane
  ): Promise<PrActiveSessionRow | null> {
    return this.prepareGetRow(repoFullName, prNumber, lane).first<PrActiveSessionRow>();
  }

  /**
   * Attempt to claim the (repo, pr, lane) slot. See the module comment for
   * the full protocol. `now` is injected (rather than read internally) so
   * tests can seed stale rows deterministically without sleeping.
   */
  async claim(params: {
    repoFullName: string;
    prNumber: number;
    lane: PrSessionLane;
    claimToken: string;
    now: number;
  }): Promise<PrSessionClaimOutcome> {
    const repoFullName = params.repoFullName.toLowerCase();
    const { prNumber, lane, claimToken, now } = params;

    const insertStmt = this.db
      .prepare(
        `INSERT INTO pr_active_sessions
           (repo_full_name, pr_number, lane, session_id, status, claim_token, updated_at)
         VALUES (?, ?, ?, NULL, 'creating', ?, ?)
         ON CONFLICT (repo_full_name, pr_number, lane) DO NOTHING`
      )
      .bind(repoFullName, prNumber, lane, claimToken, now);

    // Batched (not two separate statements): D1 executes a batch as a single
    // transaction, so no concurrent writer — in particular a release() on this
    // exact row — can land between the INSERT and this SELECT. Without the
    // batch, a release() landing in that window would delete the row the
    // INSERT just no-op'd against, and the follow-up SELECT would find
    // nothing — reproducible against a real D1 binding, not just theoretical.
    const [, selectResult] = await this.db.batch<PrActiveSessionRow>([
      insertStmt,
      this.prepareGetRow(repoFullName, prNumber, lane),
    ]);
    let row: PrActiveSessionRow | null = selectResult.results[0] ?? null;
    if (!row) {
      // Genuinely unreachable now: the INSERT and SELECT commit as one D1
      // transaction, so no other statement can observe or act on the row
      // between them — the row the INSERT created or conflicted against is
      // still there when the SELECT in the same batch runs.
      throw new Error("pr_active_sessions: row missing immediately after batched claim insert");
    }
    if (row.claim_token === claimToken) {
      return { result: "claimed" };
    }

    // Lost the insert. If the existing claim is still 'creating' and older
    // than the stale threshold, its claimer likely crashed — try to steal it.
    if (row.status === "creating" && now - row.updated_at > STALE_CLAIM_THRESHOLD_MS) {
      const staleToken = row.claim_token;
      const staleCutoff = now - STALE_CLAIM_THRESHOLD_MS;
      await this.db
        .prepare(
          `UPDATE pr_active_sessions
           SET claim_token = ?, status = 'creating', session_id = NULL, updated_at = ?
           WHERE repo_full_name = ? AND pr_number = ? AND lane = ?
             AND claim_token = ? AND updated_at < ?`
        )
        .bind(claimToken, now, repoFullName, prNumber, lane, staleToken, staleCutoff)
        .run();

      row = await this.getRow(repoFullName, prNumber, lane);
      if (row?.claim_token === claimToken) {
        return { result: "claimed" };
      }
    }

    if (!row) {
      throw new Error("pr_active_sessions: row missing after stale-claim steal attempt");
    }
    return {
      result: "existing",
      sessionId: row.session_id,
      status: row.status,
      claimToken: row.claim_token,
    };
  }

  /**
   * Confirm a won claim now that the session exists. The `claim_token` guard
   * means a claimer whose slot was stolen out from under it (because it never
   * confirmed within the stale window) cannot clobber the new owner's row —
   * confirm() simply reports `false` and the caller logs the inconsistency
   * rather than stranding the session it already created.
   */
  async confirm(params: {
    repoFullName: string;
    prNumber: number;
    lane: PrSessionLane;
    claimToken: string;
    sessionId: string;
    now: number;
  }): Promise<boolean> {
    const repoFullName = params.repoFullName.toLowerCase();
    const result = await this.db
      .prepare(
        `UPDATE pr_active_sessions
         SET session_id = ?, status = 'active', updated_at = ?
         WHERE repo_full_name = ? AND pr_number = ? AND lane = ? AND claim_token = ?`
      )
      .bind(
        params.sessionId,
        params.now,
        repoFullName,
        params.prNumber,
        params.lane,
        params.claimToken
      )
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /**
   * Free a slot so a subsequent claim() can win it fresh. Requires the row's
   * current `claim_token` (returned by claim()'s "existing" result) — a
   * mismatch (already released, already reclaimed) is a safe no-op.
   */
  async release(params: {
    repoFullName: string;
    prNumber: number;
    lane: PrSessionLane;
    claimToken: string;
  }): Promise<boolean> {
    const repoFullName = params.repoFullName.toLowerCase();
    const result = await this.db
      .prepare(
        `DELETE FROM pr_active_sessions
         WHERE repo_full_name = ? AND pr_number = ? AND lane = ? AND claim_token = ?`
      )
      .bind(repoFullName, params.prNumber, params.lane, params.claimToken)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
}
