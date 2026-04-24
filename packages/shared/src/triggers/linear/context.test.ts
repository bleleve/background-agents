import { describe, it, expect } from "vitest";
import { buildLinearContextBlock } from "./context";
import type { LinearIssueData } from "./context";
import type { LinearAutomationEvent } from "../types";

// ─── Shared fixture data ───────────────────────────────────────────────────────

const baseEvent: LinearAutomationEvent = {
  source: "linear",
  eventType: "issue.created",
  repoOwner: "acme-org",
  repoName: "my-app",
  triggerKey: "linear:org-123:issue-abc:create:2026-01-15T10:30:00.000Z",
  concurrencyKey: "linear:acme-org/my-app:issue-abc",
  contextBlock: "",
  meta: {
    issueId: "issue-abc",
    identifier: "ENG-123",
    url: "https://linear.app/acme/issue/ENG-123",
  },
  labels: ["bug", "priority:high"],
  linearStatus: "In Progress",
  actor: "John Smith",
};

const fullIssueData: LinearIssueData = {
  identifier: "ENG-123",
  title: "Fix the login bug",
  url: "https://linear.app/acme/issue/ENG-123",
  state: { name: "In Progress" },
  team: { name: "Engineering" },
  assignee: { name: "Jane Doe" },
  priority: 2,
  labels: [{ name: "bug" }, { name: "priority:high" }],
  description: "Users cannot log in when using SSO. This is a critical issue.",
  creator: { name: "John Smith" },
};

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("buildLinearContextBlock", () => {
  describe("full issue data", () => {
    it("includes issue identifier", () => {
      const block = buildLinearContextBlock(baseEvent, fullIssueData);
      expect(block).toContain("ENG-123");
    });

    it("includes issue title", () => {
      const block = buildLinearContextBlock(baseEvent, fullIssueData);
      expect(block).toContain("Fix the login bug");
    });

    it("includes the URL", () => {
      const block = buildLinearContextBlock(baseEvent, fullIssueData);
      expect(block).toContain("https://linear.app/acme/issue/ENG-123");
    });

    it("includes status name", () => {
      const block = buildLinearContextBlock(baseEvent, fullIssueData);
      expect(block).toContain("In Progress");
    });

    it("includes team name", () => {
      const block = buildLinearContextBlock(baseEvent, fullIssueData);
      expect(block).toContain("Engineering");
    });

    it("includes assignee name", () => {
      const block = buildLinearContextBlock(baseEvent, fullIssueData);
      expect(block).toContain("Jane Doe");
    });

    it("includes priority label for priority 2 (High)", () => {
      const block = buildLinearContextBlock(baseEvent, fullIssueData);
      expect(block).toContain("High");
    });

    it("includes label names", () => {
      const block = buildLinearContextBlock(baseEvent, fullIssueData);
      expect(block).toContain("bug");
      expect(block).toContain("priority:high");
    });

    it("includes description", () => {
      const block = buildLinearContextBlock(baseEvent, fullIssueData);
      expect(block).toContain("Users cannot log in when using SSO");
    });

    it("includes creator name", () => {
      const block = buildLinearContextBlock(baseEvent, fullIssueData);
      expect(block).toContain("John Smith");
    });

    it("includes the event type in the header", () => {
      const block = buildLinearContextBlock(baseEvent, fullIssueData);
      expect(block).toContain("issue.created");
    });
  });

  describe("priority labels", () => {
    it("shows 'Urgent' for priority 1", () => {
      const block = buildLinearContextBlock(baseEvent, { ...fullIssueData, priority: 1 });
      expect(block).toContain("Urgent");
    });

    it("shows 'High' for priority 2", () => {
      const block = buildLinearContextBlock(baseEvent, { ...fullIssueData, priority: 2 });
      expect(block).toContain("High");
    });

    it("shows 'Medium' for priority 3", () => {
      const block = buildLinearContextBlock(baseEvent, { ...fullIssueData, priority: 3 });
      expect(block).toContain("Medium");
    });

    it("shows 'Low' for priority 4", () => {
      const block = buildLinearContextBlock(baseEvent, { ...fullIssueData, priority: 4 });
      expect(block).toContain("Low");
    });

    it("shows 'No priority' for priority 0", () => {
      const block = buildLinearContextBlock(baseEvent, { ...fullIssueData, priority: 0 });
      expect(block).toContain("No priority");
    });
  });

  describe("minimal issue data", () => {
    it("does not crash with only required fields", () => {
      const minimalData: LinearIssueData = {
        identifier: "MIN-1",
        title: "Minimal Issue",
      };

      expect(() => buildLinearContextBlock(baseEvent, minimalData)).not.toThrow();
    });

    it("returns a non-empty string for minimal data", () => {
      const minimalData: LinearIssueData = {
        identifier: "MIN-1",
        title: "Minimal Issue",
      };
      const block = buildLinearContextBlock(baseEvent, minimalData);

      expect(block.length).toBeGreaterThan(0);
      expect(block).toContain("MIN-1");
      expect(block).toContain("Minimal Issue");
    });

    it("omits URL section when not provided", () => {
      const block = buildLinearContextBlock(baseEvent, {
        identifier: "MIN-1",
        title: "Minimal Issue",
      });

      expect(block).not.toContain("**URL**");
    });

    it("omits status section when not provided", () => {
      const block = buildLinearContextBlock(baseEvent, {
        identifier: "MIN-1",
        title: "Minimal Issue",
      });

      expect(block).not.toContain("**Status**");
    });

    it("omits team section when not provided", () => {
      const block = buildLinearContextBlock(baseEvent, {
        identifier: "MIN-1",
        title: "Minimal Issue",
      });

      expect(block).not.toContain("**Team**");
    });

    it("omits assignee section when not provided", () => {
      const block = buildLinearContextBlock(baseEvent, {
        identifier: "MIN-1",
        title: "Minimal Issue",
      });

      expect(block).not.toContain("**Assignee**");
    });

    it("omits priority section when not provided", () => {
      const block = buildLinearContextBlock(baseEvent, {
        identifier: "MIN-1",
        title: "Minimal Issue",
      });

      expect(block).not.toContain("**Priority**");
    });

    it("omits labels section when not provided", () => {
      const block = buildLinearContextBlock(baseEvent, {
        identifier: "MIN-1",
        title: "Minimal Issue",
      });

      expect(block).not.toContain("**Labels**");
    });

    it("omits description section when not provided", () => {
      const block = buildLinearContextBlock(baseEvent, {
        identifier: "MIN-1",
        title: "Minimal Issue",
      });

      expect(block).not.toContain("**Description**");
    });
  });

  describe("long description truncation", () => {
    it("truncates descriptions over 500 chars and appends (truncated)", () => {
      const longDescription = "A".repeat(501);
      const block = buildLinearContextBlock(baseEvent, {
        ...fullIssueData,
        description: longDescription,
      });

      // Should contain exactly 500 chars of the description
      expect(block).toContain("A".repeat(500));
      expect(block).toContain("(truncated)");
    });

    it("does not truncate descriptions of exactly 500 chars", () => {
      const exactDescription = "B".repeat(500);
      const block = buildLinearContextBlock(baseEvent, {
        ...fullIssueData,
        description: exactDescription,
      });

      expect(block).toContain("B".repeat(500));
      expect(block).not.toContain("(truncated)");
    });

    it("does not truncate short descriptions", () => {
      const shortDescription = "Short description";
      const block = buildLinearContextBlock(baseEvent, {
        ...fullIssueData,
        description: shortDescription,
      });

      expect(block).toContain(shortDescription);
      expect(block).not.toContain("(truncated)");
    });
  });

  describe("updated event type", () => {
    it("reflects issue.updated in the header when event type is update", () => {
      const updatedEvent: LinearAutomationEvent = { ...baseEvent, eventType: "issue.updated" };
      const block = buildLinearContextBlock(updatedEvent, fullIssueData);

      expect(block).toContain("issue.updated");
    });
  });
});
