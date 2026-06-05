import { describe, it, expect } from "vitest";
import { reviewSessionTitle, parseReviewSessionPrNumber } from "./models";

describe("reviewSessionTitle / parseReviewSessionPrNumber", () => {
  it("round-trips a PR number through the review-session title", () => {
    expect(reviewSessionTitle(42)).toBe("GitHub: Review PR #42");
    expect(parseReviewSessionPrNumber(reviewSessionTitle(42))).toBe(42);
  });

  it("returns null for non-review titles, comment-action titles, and empty input", () => {
    expect(parseReviewSessionPrNumber("Fix the cache bug")).toBeNull();
    expect(parseReviewSessionPrNumber("GitHub: PR #42 comment")).toBeNull();
    expect(parseReviewSessionPrNumber(null)).toBeNull();
    expect(parseReviewSessionPrNumber(undefined)).toBeNull();
    expect(parseReviewSessionPrNumber("")).toBeNull();
  });
});
