import { describe, expect, it } from "vitest";
import { shouldWarmForPrompt, WARMUP_MIN_TRIMMED_CHARS } from "./sandbox-warming";

describe("shouldWarmForPrompt", () => {
  it("warms once the trimmed length is strictly greater than the threshold", () => {
    expect(shouldWarmForPrompt("a".repeat(WARMUP_MIN_TRIMMED_CHARS + 1))).toBe(true);
  });

  it("does not warm at exactly the threshold", () => {
    expect(shouldWarmForPrompt("a".repeat(WARMUP_MIN_TRIMMED_CHARS))).toBe(false);
  });

  it("ignores surrounding whitespace when measuring intent", () => {
    expect(shouldWarmForPrompt("   ab   ")).toBe(false);
    expect(shouldWarmForPrompt(`  ${"a".repeat(WARMUP_MIN_TRIMMED_CHARS + 1)}  `)).toBe(true);
  });

  it("does not warm on empty or whitespace-only input", () => {
    expect(shouldWarmForPrompt("")).toBe(false);
    expect(shouldWarmForPrompt("       ")).toBe(false);
  });
});
