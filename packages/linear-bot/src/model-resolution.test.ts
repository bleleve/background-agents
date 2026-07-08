import { describe, expect, it } from "vitest";
import {
  isNoPlanLabelPresent,
  isPlanModeTriggered,
  isPreviewEnabled,
  resolvePlanModeTrigger,
  type LinearLabel,
} from "./model-resolution";

function labels(...names: string[]): LinearLabel[] {
  return names.map((name) => ({ name }));
}

describe("isNoPlanLabelPresent", () => {
  it("detects the bare no-plan label, case-insensitively", () => {
    expect(isNoPlanLabelPresent(labels("no-plan"))).toBe(true);
    expect(isNoPlanLabelPresent(labels("No-Plan"))).toBe(true);
  });

  it("is false when absent", () => {
    expect(isNoPlanLabelPresent(labels("plan", "preview"))).toBe(false);
    expect(isNoPlanLabelPresent([])).toBe(false);
  });

  it("does not match plan-<alias> style labels", () => {
    expect(isNoPlanLabelPresent(labels("plan-sonnet"))).toBe(false);
  });
});

describe("resolvePlanModeTrigger", () => {
  it("returns true for bare plan or plan-<alias>", () => {
    expect(resolvePlanModeTrigger(labels("plan"))).toBe(true);
    expect(resolvePlanModeTrigger(labels("plan-sonnet"))).toBe(true);
  });

  it("returns false for no-plan", () => {
    expect(resolvePlanModeTrigger(labels("no-plan"))).toBe(false);
  });

  it("returns undefined when neither is present, so the caller can infer", () => {
    expect(resolvePlanModeTrigger(labels("preview", "model-sonnet"))).toBeUndefined();
    expect(resolvePlanModeTrigger([])).toBeUndefined();
  });

  it("plan outranks no-plan when both are somehow applied", () => {
    expect(resolvePlanModeTrigger(labels("plan", "no-plan"))).toBe(true);
  });

  it("stays consistent with isPlanModeTriggered for the plan-only cases", () => {
    for (const set of [labels("plan"), labels("plan-opus"), labels("preview")]) {
      expect(resolvePlanModeTrigger(set) === true).toBe(isPlanModeTriggered(set));
    }
  });
});

describe("isPreviewEnabled (regression guard — untouched by this change)", () => {
  it("still detects the preview label", () => {
    expect(isPreviewEnabled(labels("preview"))).toBe(true);
    expect(isPreviewEnabled(labels("plan"))).toBe(false);
  });
});
