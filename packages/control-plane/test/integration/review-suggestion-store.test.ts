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
