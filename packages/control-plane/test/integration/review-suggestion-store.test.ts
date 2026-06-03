import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  ReviewSuggestionStore,
  type ReviewSuggestionEntry,
} from "../../src/db/review-suggestion-store";
import { cleanD1Tables } from "./cleanup";

function makeEntry(overrides?: Partial<ReviewSuggestionEntry>): ReviewSuggestionEntry {
  const now = Date.now();
  return {
    id: `sug-${Math.random().toString(36).slice(2, 8)}`,
    repoOwner: "acme",
    repoName: "web-app",
    prNumber: 42,
    commentId: Math.floor(Math.random() * 1_000_000),
    file: "src/index.ts",
    line: 10,
    model: "anthropic/claude-sonnet-4-6",
    promptVersion: "v1",
    riskScore: "medium",
    status: "open",
    createdAt: now,
    resolvedAt: null,
    ...overrides,
  };
}

describe("ReviewSuggestionStore (D1 integration)", () => {
  beforeEach(cleanD1Tables);

  it("records suggestions and computes acceptance rate after resolution", async () => {
    const store = new ReviewSuggestionStore(env.DB);
    await store.record(makeEntry({ commentId: 1, model: "m" }));
    await store.record(makeEntry({ commentId: 2, model: "m" }));

    let rate = await store.acceptanceRate({ model: "m" });
    expect(rate.total).toBe(2);
    expect(rate.resolved).toBe(0);
    expect(rate.rate).toBe(0);

    const resolvedCount = await store.markResolved([1, 999], Date.now());
    expect(resolvedCount).toBe(1); // 999 does not exist

    rate = await store.acceptanceRate({ model: "m" });
    expect(rate.total).toBe(2);
    expect(rate.resolved).toBe(1);
    expect(rate.rate).toBeCloseTo(0.5);
  });

  it("is idempotent on comment_id", async () => {
    const store = new ReviewSuggestionStore(env.DB);
    await store.record(makeEntry({ commentId: 5 }));
    await store.record(makeEntry({ commentId: 5, riskScore: "high" }));

    const rate = await store.acceptanceRate();
    expect(rate.total).toBe(1);
  });

  it("does not re-resolve an already-resolved suggestion", async () => {
    const store = new ReviewSuggestionStore(env.DB);
    await store.record(makeEntry({ commentId: 7 }));

    expect(await store.markResolved([7], Date.now())).toBe(1);
    expect(await store.markResolved([7], Date.now())).toBe(0);
  });

  it("filters acceptance rate by repo", async () => {
    const store = new ReviewSuggestionStore(env.DB);
    await store.record(makeEntry({ commentId: 10, repoOwner: "acme", repoName: "web-app" }));
    await store.record(makeEntry({ commentId: 11, repoOwner: "acme", repoName: "other" }));

    const rate = await store.acceptanceRate({ repoOwner: "acme", repoName: "web-app" });
    expect(rate.total).toBe(1);
  });
});

describe("ReviewSuggestionStore analytics (D1 integration)", () => {
  beforeEach(cleanD1Tables);

  const base = 1_700_000_000_000; // fixed instant for deterministic day buckets
  const filters = { startAt: base - 1000, endAt: base + 7 * 24 * 60 * 60 * 1000 };

  it("summary: total, prsReviewed, perPr, resolved", async () => {
    const store = new ReviewSuggestionStore(env.DB);
    // PR 42: two suggestions (one resolved) ; PR 43: one suggestion
    await store.record(makeEntry({ commentId: 1, prNumber: 42, createdAt: base }));
    await store.record(makeEntry({ commentId: 2, prNumber: 42, createdAt: base + 1000 }));
    await store.record(makeEntry({ commentId: 3, prNumber: 43, createdAt: base + 2000 }));
    await store.markResolved([1], base + 5000);

    const s = await store.summary(filters);
    expect(s.total).toBe(3);
    expect(s.prsReviewed).toBe(2);
    expect(s.perPr).toBeCloseTo(1.5);
    expect(s.resolved).toBe(1);
  });

  it("summary: excludes suggestions outside the range", async () => {
    const store = new ReviewSuggestionStore(env.DB);
    await store.record(makeEntry({ commentId: 1, createdAt: base }));
    await store.record(makeEntry({ commentId: 2, createdAt: base - 10_000 })); // before range

    const s = await store.summary(filters);
    expect(s.total).toBe(1);
  });

  it("breakdown by model buckets missing model under 'unknown'", async () => {
    const store = new ReviewSuggestionStore(env.DB);
    await store.record(makeEntry({ commentId: 1, model: "opus", createdAt: base }));
    await store.record(makeEntry({ commentId: 2, model: "opus", createdAt: base + 1 }));
    await store.record(makeEntry({ commentId: 3, model: null, createdAt: base + 2 }));

    const { entries } = await store.breakdown(filters, "model");
    expect(entries[0]).toMatchObject({ key: "opus", total: 2 });
    expect(entries.find((e) => e.key === "unknown")?.total).toBe(1);
  });

  it("breakdown by model counts distinct PRs across repos (same pr_number, different repo)", async () => {
    const store = new ReviewSuggestionStore(env.DB);
    // Same model and same pr_number, but two different repos — must count as 2 PRs.
    await store.record(
      makeEntry({ commentId: 1, model: "m", prNumber: 1, repoName: "backend", createdAt: base })
    );
    await store.record(
      makeEntry({
        commentId: 2,
        model: "m",
        prNumber: 1,
        repoName: "frontend",
        createdAt: base + 1,
      })
    );

    const { entries } = await store.breakdown(filters, "model");
    expect(entries[0]).toMatchObject({ key: "m", total: 2, prs: 2 });
    expect(entries[0].perPr).toBeCloseTo(1);
  });

  it("breakdown by repo computes perPr from distinct PRs", async () => {
    const store = new ReviewSuggestionStore(env.DB);
    await store.record(makeEntry({ commentId: 1, prNumber: 1, createdAt: base }));
    await store.record(makeEntry({ commentId: 2, prNumber: 1, createdAt: base + 1 }));
    await store.record(makeEntry({ commentId: 3, prNumber: 2, createdAt: base + 2 }));

    const { entries } = await store.breakdown(filters, "repo");
    expect(entries[0]).toMatchObject({ key: "acme/web-app", total: 3, prs: 2 });
    expect(entries[0].perPr).toBeCloseTo(1.5);
  });

  it("timeseries merges posted (by created) and resolved (by resolved_at) per day", async () => {
    const store = new ReviewSuggestionStore(env.DB);
    const day2 = base + 24 * 60 * 60 * 1000;
    await store.record(makeEntry({ commentId: 1, createdAt: base }));
    await store.record(makeEntry({ commentId: 2, createdAt: day2 }));
    await store.markResolved([1], day2); // resolved on day 2

    const { series } = await store.timeseries(filters);
    const totalPosted = series.reduce((n, p) => n + p.posted, 0);
    const totalResolved = series.reduce((n, p) => n + p.resolved, 0);
    expect(totalPosted).toBe(2);
    expect(totalResolved).toBe(1);
    // dates sorted ascending
    expect([...series].sort((a, b) => (a.date < b.date ? -1 : 1))).toEqual(series);
  });
});
