import { describe, it, expect } from "vitest";
import { reviewSessionTitle, parseReviewSessionPrNumber, parseRetryCommand } from "./models";

describe("parseRetryCommand", () => {
  it("matches a lone retry/relaunch reply, case- and whitespace-insensitive", () => {
    expect(parseRetryCommand("retry")).toEqual({ command: "retry" });
    expect(parseRetryCommand("RETRY")).toEqual({ command: "retry" });
    expect(parseRetryCommand("  retry  ")).toEqual({ command: "retry" });
    expect(parseRetryCommand("relaunch")).toEqual({ command: "retry" });
    expect(parseRetryCommand("Relaunch")).toEqual({ command: "retry" });
  });

  it("does not match a prompt that merely starts with retry, or empty/other input", () => {
    expect(parseRetryCommand("retry the build")).toBeNull();
    expect(parseRetryCommand("please retry")).toBeNull();
    expect(parseRetryCommand("approve")).toBeNull();
    expect(parseRetryCommand("")).toBeNull();
    expect(parseRetryCommand("   ")).toBeNull();
  });
});

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
