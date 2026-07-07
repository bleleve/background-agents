import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { generateInternalToken } from "../../src/auth/internal";
import {
  PrActiveSessionStore,
  STALE_CLAIM_THRESHOLD_MS,
  type PrSessionClaimOutcome,
} from "../../src/db/pr-active-sessions";
import { cleanD1Tables } from "./cleanup";

async function authHeaders(): Promise<Record<string, string>> {
  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

const REPO = "acme/widgets";
const PR_NUMBER = 42;

describe("PR active session claim/confirm/release (D1 integration)", () => {
  beforeEach(cleanD1Tables);

  describe("POST /internal/pr-sessions/claim (HTTP wiring)", () => {
    it("returns 401 without auth", async () => {
      const response = await SELF.fetch("https://test.local/internal/pr-sessions/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoFullName: REPO,
          prNumber: PR_NUMBER,
          lane: "request",
          claimToken: "tok-1",
        }),
      });
      expect(response.status).toBe(401);
    });

    it("rejects an invalid lane", async () => {
      const headers = await authHeaders();
      const response = await SELF.fetch("https://test.local/internal/pr-sessions/claim", {
        method: "POST",
        headers,
        body: JSON.stringify({
          repoFullName: REPO,
          prNumber: PR_NUMBER,
          lane: "bogus",
          claimToken: "tok-1",
        }),
      });
      expect(response.status).toBe(400);
    });

    it("two concurrent claims for the same (repo, pr, lane) — exactly one wins", async () => {
      const headers = await authHeaders();
      const claimBody = (claimToken: string) =>
        JSON.stringify({ repoFullName: REPO, prNumber: PR_NUMBER, lane: "request", claimToken });

      const [resA, resB] = await Promise.all([
        SELF.fetch("https://test.local/internal/pr-sessions/claim", {
          method: "POST",
          headers,
          body: claimBody("tok-a"),
        }),
        SELF.fetch("https://test.local/internal/pr-sessions/claim", {
          method: "POST",
          headers,
          body: claimBody("tok-b"),
        }),
      ]);

      const [bodyA, bodyB] = await Promise.all([
        resA.json<PrSessionClaimOutcome>(),
        resB.json<PrSessionClaimOutcome>(),
      ]);

      const results = [bodyA.result, bodyB.result];
      // Exactly one claimed, the other sees it as existing (status 'creating',
      // no sessionId yet — the winner hasn't confirmed).
      expect(results.filter((r) => r === "claimed")).toHaveLength(1);
      expect(results.filter((r) => r === "existing")).toHaveLength(1);

      const existing = (bodyA.result === "existing" ? bodyA : bodyB) as Extract<
        PrSessionClaimOutcome,
        { result: "existing" }
      >;
      expect(existing.status).toBe("creating");
      expect(existing.sessionId).toBeNull();
    });

    it("full claim -> confirm -> second caller coalesces onto the confirmed session", async () => {
      const headers = await authHeaders();

      const claimRes = await SELF.fetch("https://test.local/internal/pr-sessions/claim", {
        method: "POST",
        headers,
        body: JSON.stringify({
          repoFullName: REPO,
          prNumber: PR_NUMBER,
          lane: "review",
          claimToken: "tok-winner",
        }),
      });
      expect((await claimRes.json<PrSessionClaimOutcome>()).result).toBe("claimed");

      const confirmRes = await SELF.fetch("https://test.local/internal/pr-sessions/confirm", {
        method: "POST",
        headers,
        body: JSON.stringify({
          repoFullName: REPO,
          prNumber: PR_NUMBER,
          lane: "review",
          claimToken: "tok-winner",
          sessionId: "session-abc",
        }),
      });
      expect((await confirmRes.json<{ updated: boolean }>()).updated).toBe(true);

      const secondClaimRes = await SELF.fetch("https://test.local/internal/pr-sessions/claim", {
        method: "POST",
        headers,
        body: JSON.stringify({
          repoFullName: REPO,
          prNumber: PR_NUMBER,
          lane: "review",
          claimToken: "tok-loser",
        }),
      });
      const secondBody = await secondClaimRes.json<PrSessionClaimOutcome>();
      expect(secondBody).toEqual({
        result: "existing",
        sessionId: "session-abc",
        status: "active",
        claimToken: "tok-winner",
      });
    });
  });

  describe("GET /internal/pr-sessions/peek", () => {
    it("returns null for a slot with no row", async () => {
      const headers = await authHeaders();
      const response = await SELF.fetch(
        `https://test.local/internal/pr-sessions/peek?repoFullName=${encodeURIComponent(REPO)}&prNumber=${PR_NUMBER}&lane=review`,
        { headers }
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ sessionId: null, status: null });
    });

    it("returns null sessionId while a claim is still 'creating' (unconfirmed)", async () => {
      const headers = await authHeaders();
      await SELF.fetch("https://test.local/internal/pr-sessions/claim", {
        method: "POST",
        headers,
        body: JSON.stringify({
          repoFullName: REPO,
          prNumber: PR_NUMBER,
          lane: "review",
          claimToken: "tok-pending",
        }),
      });

      const response = await SELF.fetch(
        `https://test.local/internal/pr-sessions/peek?repoFullName=${encodeURIComponent(REPO)}&prNumber=${PR_NUMBER}&lane=review`,
        { headers }
      );
      expect(await response.json()).toEqual({ sessionId: null, status: "creating" });
    });

    it("returns the confirmed sessionId once claimed and confirmed", async () => {
      const headers = await authHeaders();
      await SELF.fetch("https://test.local/internal/pr-sessions/claim", {
        method: "POST",
        headers,
        body: JSON.stringify({
          repoFullName: REPO,
          prNumber: PR_NUMBER,
          lane: "review",
          claimToken: "tok-confirmed",
        }),
      });
      await SELF.fetch("https://test.local/internal/pr-sessions/confirm", {
        method: "POST",
        headers,
        body: JSON.stringify({
          repoFullName: REPO,
          prNumber: PR_NUMBER,
          lane: "review",
          claimToken: "tok-confirmed",
          sessionId: "session-peek",
        }),
      });

      const response = await SELF.fetch(
        `https://test.local/internal/pr-sessions/peek?repoFullName=${encodeURIComponent(REPO)}&prNumber=${PR_NUMBER}&lane=review`,
        { headers }
      );
      expect(await response.json()).toEqual({ sessionId: "session-peek", status: "active" });
    });

    it("does not claim the slot as a side effect (peek is read-only)", async () => {
      const headers = await authHeaders();
      await SELF.fetch(
        `https://test.local/internal/pr-sessions/peek?repoFullName=${encodeURIComponent(REPO)}&prNumber=${PR_NUMBER}&lane=review`,
        { headers }
      );

      // The slot must still be freely claimable — peek must not have inserted a row.
      const claimRes = await SELF.fetch("https://test.local/internal/pr-sessions/claim", {
        method: "POST",
        headers,
        body: JSON.stringify({
          repoFullName: REPO,
          prNumber: PR_NUMBER,
          lane: "review",
          claimToken: "tok-after-peek",
        }),
      });
      expect(await claimRes.json<PrSessionClaimOutcome>()).toEqual({ result: "claimed" });
    });
  });

  describe("PrActiveSessionStore (direct D1)", () => {
    it("confirm only succeeds when the claim_token matches", async () => {
      const store = new PrActiveSessionStore(env.DB);
      const now = Date.now();

      const claimOutcome = await store.claim({
        repoFullName: REPO,
        prNumber: PR_NUMBER,
        lane: "request",
        claimToken: "tok-real",
        now,
      });
      expect(claimOutcome).toEqual({ result: "claimed" });

      // A confirm with the wrong token (e.g. a stale/lost claimer) must not update the row.
      const wrongConfirm = await store.confirm({
        repoFullName: REPO,
        prNumber: PR_NUMBER,
        lane: "request",
        claimToken: "tok-imposter",
        sessionId: "session-nope",
        now: now + 1,
      });
      expect(wrongConfirm).toBe(false);

      const rightConfirm = await store.confirm({
        repoFullName: REPO,
        prNumber: PR_NUMBER,
        lane: "request",
        claimToken: "tok-real",
        sessionId: "session-yes",
        now: now + 2,
      });
      expect(rightConfirm).toBe(true);

      // Verify the row reflects the successful confirm, not the rejected one.
      const followUp = await store.claim({
        repoFullName: REPO,
        prNumber: PR_NUMBER,
        lane: "request",
        claimToken: "tok-other",
        now: now + 3,
      });
      expect(followUp).toEqual({
        result: "existing",
        sessionId: "session-yes",
        status: "active",
        claimToken: "tok-real",
      });
    });

    it("steals a stale 'creating' claim past the threshold, but not a fresh one", async () => {
      const store = new PrActiveSessionStore(env.DB);
      const now = Date.now();

      // Seed a row directly (bypassing claim()) with an old updated_at, as if a
      // claimer won the slot and then crashed before confirming. Raw D1 write
      // instead of sleeping — wall-clock can't be fast-forwarded reliably here.
      await env.DB.prepare(
        `INSERT INTO pr_active_sessions
           (repo_full_name, pr_number, lane, session_id, status, claim_token, updated_at)
         VALUES (?, ?, ?, NULL, 'creating', ?, ?)`
      )
        .bind(REPO, PR_NUMBER, "request", "tok-crashed", now - STALE_CLAIM_THRESHOLD_MS - 1)
        .run();

      const stolen = await store.claim({
        repoFullName: REPO,
        prNumber: PR_NUMBER,
        lane: "request",
        claimToken: "tok-rescuer",
        now,
      });
      expect(stolen).toEqual({ result: "claimed" });

      // A second, not-yet-stale 'creating' claim must NOT be stealable.
      await cleanD1Tables();
      await env.DB.prepare(
        `INSERT INTO pr_active_sessions
           (repo_full_name, pr_number, lane, session_id, status, claim_token, updated_at)
         VALUES (?, ?, ?, NULL, 'creating', ?, ?)`
      )
        .bind(REPO, PR_NUMBER, "request", "tok-in-progress", now - STALE_CLAIM_THRESHOLD_MS + 5_000)
        .run();

      const notStolen = await store.claim({
        repoFullName: REPO,
        prNumber: PR_NUMBER,
        lane: "request",
        claimToken: "tok-impatient",
        now,
      });
      expect(notStolen).toEqual({
        result: "existing",
        sessionId: null,
        status: "creating",
        claimToken: "tok-in-progress",
      });
    });

    it("release frees the slot for a subsequent claim", async () => {
      const store = new PrActiveSessionStore(env.DB);
      const now = Date.now();

      await store.claim({
        repoFullName: REPO,
        prNumber: PR_NUMBER,
        lane: "request",
        claimToken: "tok-dead-session",
        now,
      });
      await store.confirm({
        repoFullName: REPO,
        prNumber: PR_NUMBER,
        lane: "request",
        claimToken: "tok-dead-session",
        sessionId: "session-terminal",
        now: now + 1,
      });

      // A release with a mismatched token is a safe no-op.
      const noopRelease = await store.release({
        repoFullName: REPO,
        prNumber: PR_NUMBER,
        lane: "request",
        claimToken: "tok-not-it",
      });
      expect(noopRelease).toBe(false);

      const released = await store.release({
        repoFullName: REPO,
        prNumber: PR_NUMBER,
        lane: "request",
        claimToken: "tok-dead-session",
      });
      expect(released).toBe(true);

      // The slot is free — a fresh claim wins outright instead of seeing "existing".
      const freshClaim = await store.claim({
        repoFullName: REPO,
        prNumber: PR_NUMBER,
        lane: "request",
        claimToken: "tok-fresh",
        now: now + 2,
      });
      expect(freshClaim).toEqual({ result: "claimed" });
    });

    it("keeps 'review' and 'request' lanes independent for the same PR", async () => {
      const store = new PrActiveSessionStore(env.DB);
      const now = Date.now();

      const reviewClaim = await store.claim({
        repoFullName: REPO,
        prNumber: PR_NUMBER,
        lane: "review",
        claimToken: "tok-review",
        now,
      });
      const requestClaim = await store.claim({
        repoFullName: REPO,
        prNumber: PR_NUMBER,
        lane: "request",
        claimToken: "tok-request",
        now,
      });

      expect(reviewClaim).toEqual({ result: "claimed" });
      expect(requestClaim).toEqual({ result: "claimed" });
    });
  });
});
