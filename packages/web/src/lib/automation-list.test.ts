import { describe, expect, it } from "vitest";
import {
  AUTOMATIONS_API_PATH,
  buildAutomationsListKey,
  CURRENT_USER_CREATED_BY,
} from "./automation-list";

describe("buildAutomationsListKey", () => {
  it("returns the base path when no filters are provided", () => {
    expect(buildAutomationsListKey()).toBe(AUTOMATIONS_API_PATH);
  });

  it("includes createdBy=me when filtering to the current user", () => {
    expect(buildAutomationsListKey({ createdBy: [CURRENT_USER_CREATED_BY] })).toBe(
      "/api/automations?createdBy=me"
    );
  });

  it("supports explicit creator filters", () => {
    expect(
      buildAutomationsListKey({
        createdBy: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
      })
    ).toBe(
      "/api/automations?createdBy=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&createdBy=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    );
  });
});
