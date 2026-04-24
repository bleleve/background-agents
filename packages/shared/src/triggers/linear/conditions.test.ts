import { describe, it, expect } from "vitest";
import { matchesConditions } from "../conditions";
import { conditionRegistry } from "../registry";
import { buildMockEvent } from "../testing";

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("Linear event conditions", () => {
  describe("label condition", () => {
    it("matches when issue has the specified label (any_of)", () => {
      const event = buildMockEvent("linear", {
        labels: ["bug", "priority:high"],
      });
      const conditions = [{ type: "label" as const, operator: "any_of" as const, value: ["bug"] }];

      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(true);
    });

    it("matches when issue has any of the specified labels", () => {
      const event = buildMockEvent("linear", {
        labels: ["bug", "priority:high"],
      });
      const conditions = [
        { type: "label" as const, operator: "any_of" as const, value: ["urgent", "bug"] },
      ];

      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(true);
    });

    it("does not match when issue has none of the specified labels (any_of)", () => {
      const event = buildMockEvent("linear", {
        labels: ["documentation"],
      });
      const conditions = [
        { type: "label" as const, operator: "any_of" as const, value: ["bug", "urgent"] },
      ];

      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(false);
    });

    it("matches when issue has no labels and condition is none_of", () => {
      const event = buildMockEvent("linear", {
        labels: undefined,
      });
      const conditions = [{ type: "label" as const, operator: "none_of" as const, value: ["bug"] }];

      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(true);
    });

    it("does not match when issue has a label from a none_of list", () => {
      const event = buildMockEvent("linear", {
        labels: ["bug"],
      });
      const conditions = [{ type: "label" as const, operator: "none_of" as const, value: ["bug"] }];

      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(false);
    });
  });

  describe("actor condition", () => {
    it("matches when event.actor is in the include list", () => {
      const event = buildMockEvent("linear", {
        actor: "john-smith",
      });
      const conditions = [
        { type: "actor" as const, operator: "include" as const, value: ["john-smith"] },
      ];

      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(true);
    });

    it("matches when event.actor is one of multiple actors in include list", () => {
      const event = buildMockEvent("linear", {
        actor: "jane-doe",
      });
      const conditions = [
        {
          type: "actor" as const,
          operator: "include" as const,
          value: ["john-smith", "jane-doe"],
        },
      ];

      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(true);
    });

    it("does not match when event.actor is not in include list", () => {
      const event = buildMockEvent("linear", {
        actor: "unknown-user",
      });
      const conditions = [
        { type: "actor" as const, operator: "include" as const, value: ["john-smith"] },
      ];

      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(false);
    });

    it("matches when event.actor is not in the exclude list", () => {
      const event = buildMockEvent("linear", {
        actor: "john-smith",
      });
      const conditions = [
        { type: "actor" as const, operator: "exclude" as const, value: ["bad-actor"] },
      ];

      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(true);
    });

    it("does not match when event.actor is in the exclude list", () => {
      const event = buildMockEvent("linear", {
        actor: "bad-actor",
      });
      const conditions = [
        { type: "actor" as const, operator: "exclude" as const, value: ["bad-actor"] },
      ];

      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(false);
    });

    it("does not match when actor is undefined and operator is include", () => {
      const event = buildMockEvent("linear", {
        actor: undefined,
      });
      const conditions = [
        { type: "actor" as const, operator: "include" as const, value: ["john-smith"] },
      ];

      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(false);
    });
  });

  describe("linear_status condition", () => {
    it("matches when event.linearStatus is in the any_of list", () => {
      const event = buildMockEvent("linear", {
        linearStatus: "In Progress",
      });
      const conditions = [
        {
          type: "linear_status" as const,
          operator: "any_of" as const,
          value: ["In Progress", "In Review"],
        },
      ];

      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(true);
    });

    it("matches when event.linearStatus exactly matches the only value", () => {
      const event = buildMockEvent("linear", {
        linearStatus: "Done",
      });
      const conditions = [
        { type: "linear_status" as const, operator: "any_of" as const, value: ["Done"] },
      ];

      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(true);
    });

    it("does not match when status is not in the any_of list", () => {
      const event = buildMockEvent("linear", {
        linearStatus: "Backlog",
      });
      const conditions = [
        {
          type: "linear_status" as const,
          operator: "any_of" as const,
          value: ["In Progress", "Done"],
        },
      ];

      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(false);
    });

    it("does not match when linearStatus is undefined", () => {
      const event = buildMockEvent("linear", {
        linearStatus: undefined,
      });
      const conditions = [
        { type: "linear_status" as const, operator: "any_of" as const, value: ["In Progress"] },
      ];

      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(false);
    });
  });

  describe("multiple conditions", () => {
    it("returns true when all conditions match", () => {
      const event = buildMockEvent("linear", {
        labels: ["bug"],
        actor: "john-smith",
        linearStatus: "In Progress",
      });
      const conditions = [
        { type: "label" as const, operator: "any_of" as const, value: ["bug"] },
        { type: "actor" as const, operator: "include" as const, value: ["john-smith"] },
        { type: "linear_status" as const, operator: "any_of" as const, value: ["In Progress"] },
      ];

      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(true);
    });

    it("returns false when any condition fails", () => {
      const event = buildMockEvent("linear", {
        labels: ["bug"],
        actor: "john-smith",
        linearStatus: "Backlog",
      });
      const conditions = [
        { type: "label" as const, operator: "any_of" as const, value: ["bug"] },
        { type: "linear_status" as const, operator: "any_of" as const, value: ["In Progress"] },
      ];

      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(false);
    });

    it("returns true with no conditions", () => {
      const event = buildMockEvent("linear");
      expect(matchesConditions([], event, conditionRegistry)).toBe(true);
    });
  });
});
