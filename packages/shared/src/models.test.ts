import { describe, it, expect } from "vitest";
import { reviewSessionTitle, parseReviewSessionPrNumber, isReviewRequestComment } from "./models";

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

describe("isReviewRequestComment", () => {
  it("matches natural-language review requests (after the @mention is stripped)", () => {
    for (const text of [
      "can you review it?",
      "can you review again?",
      "review again",
      "please re-review",
      "re-review",
      "rereview please",
      "review",
      "could you review this PR?",
      "would you review the changes",
      "do a review",
      "review it once more",
      "  Can you REVIEW it again??  ",
    ]) {
      expect(isReviewRequestComment(text), text).toBe(true);
    }
  });

  it("does not match comments that merely mention review or ask for something else", () => {
    for (const text of [
      "the review you gave is wrong, fix the bug in auth.ts",
      "address the review comments",
      "review the auth flow and refactor the helper",
      "can you fix the failing test?",
      "thanks for the review!",
      "why did the review miss this?",
      "",
      "   ",
    ]) {
      expect(isReviewRequestComment(text), text).toBe(false);
    }
  });
});
