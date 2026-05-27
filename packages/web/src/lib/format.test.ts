import { describe, expect, it } from "vitest";
import { formatJsonPathFilter, formatConditionValue } from "./format";
import type { TriggerCondition } from "@open-inspect/shared";

describe("formatJsonPathFilter", () => {
  it("formats an eq comparison with a string value", () => {
    expect(formatJsonPathFilter({ path: "$.status", comparison: "eq", value: "open" })).toBe(
      '$.status eq "open"'
    );
  });

  it("formats a numeric value", () => {
    expect(formatJsonPathFilter({ path: "$.count", comparison: "gt", value: 5 })).toBe(
      "$.count gt 5"
    );
  });

  it("formats a boolean value", () => {
    expect(formatJsonPathFilter({ path: "$.merged", comparison: "eq", value: true })).toBe(
      "$.merged eq true"
    );
  });

  it("formats an exists comparison (no value)", () => {
    expect(formatJsonPathFilter({ path: "$.labels", comparison: "exists" })).toBe(
      "$.labels exists"
    );
  });

  it("formats a contains comparison", () => {
    expect(formatJsonPathFilter({ path: "$.body", comparison: "contains", value: "hotfix" })).toBe(
      '$.body contains "hotfix"'
    );
  });
});

describe("formatConditionValue", () => {
  it("formats a jsonpath condition with multiple filters", () => {
    const condition: TriggerCondition = {
      type: "jsonpath",
      operator: "all_match",
      value: [
        { path: "$.status", comparison: "eq", value: "open" },
        { path: "$.labels", comparison: "exists" },
      ],
    };
    expect(formatConditionValue(condition)).toBe('$.status eq "open", $.labels exists');
  });

  it("formats a jsonpath condition with a single filter", () => {
    const condition: TriggerCondition = {
      type: "jsonpath",
      operator: "all_match",
      value: [{ path: "$.action", comparison: "eq", value: "opened" }],
    };
    expect(formatConditionValue(condition)).toBe('$.action eq "opened"');
  });

  it("does not produce [object Object] for jsonpath conditions", () => {
    const condition: TriggerCondition = {
      type: "jsonpath",
      operator: "all_match",
      value: [{ path: "$.foo", comparison: "eq", value: "bar" }],
    };
    expect(formatConditionValue(condition)).not.toContain("[object Object]");
  });

  it("formats a branch condition (string array)", () => {
    const condition: TriggerCondition = {
      type: "branch",
      operator: "glob_match",
      value: ["main", "release/*"],
    };
    expect(formatConditionValue(condition)).toBe("main, release/*");
  });

  it("formats a label condition (string array)", () => {
    const condition: TriggerCondition = {
      type: "label",
      operator: "any_of",
      value: ["bug", "enhancement"],
    };
    expect(formatConditionValue(condition)).toBe("bug, enhancement");
  });

  it("formats a check_conclusion condition (scalar string)", () => {
    const condition: TriggerCondition = {
      type: "check_conclusion",
      operator: "eq",
      value: "success",
    };
    expect(formatConditionValue(condition)).toBe("success");
  });
});
