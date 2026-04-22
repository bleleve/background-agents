import { describe, it, expect } from "vitest";
import { normalizeLinearEvent } from "./normalizer";
import type { LinearWebhookPayload } from "./normalizer";

// ─── Shared fixture data ───────────────────────────────────────────────────────

const basePayload: LinearWebhookPayload = {
  type: "Issue",
  action: "create",
  organizationId: "org-123",
  webhookId: "webhook-456",
  createdAt: "2026-01-15T10:30:00.000Z",
  data: {
    id: "issue-abc",
    identifier: "ENG-123",
    title: "Fix the login bug",
    description: "Users cannot log in when using SSO",
    state: { id: "state-1", name: "In Progress", type: "started" },
    team: { id: "team-1", name: "Engineering", key: "ENG" },
    assignee: { id: "user-2", name: "Jane Doe", email: "jane@example.com" },
    labels: [
      { id: "label-1", name: "bug", color: "#ff0000" },
      { id: "label-2", name: "priority:high", color: "#ff8800" },
    ],
    priority: 2,
    url: "https://linear.app/acme/issue/ENG-123",
    project: { id: "proj-1", name: "Q1 Roadmap" },
    updatedAt: "2026-01-15T10:30:00.000Z",
    createdAt: "2026-01-15T10:00:00.000Z",
    creator: { id: "user-1", name: "John Smith" },
  },
};

const repoOwner = "acme-org";
const repoName = "my-app";

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("normalizeLinearEvent", () => {
  describe("issue created event", () => {
    it("returns a LinearAutomationEvent with all fields populated", () => {
      const event = normalizeLinearEvent(basePayload, repoOwner, repoName);

      expect(event).not.toBeNull();
      expect(event!.source).toBe("linear");
      expect(event!.eventType).toBe("issue.created");
      expect(event!.repoOwner).toBe(repoOwner);
      expect(event!.repoName).toBe(repoName);
    });

    it("extracts labels as array of name strings", () => {
      const event = normalizeLinearEvent(basePayload, repoOwner, repoName);

      expect(event).not.toBeNull();
      expect(event!.labels).toEqual(["bug", "priority:high"]);
    });

    it("extracts linearStatus from data.state.name", () => {
      const event = normalizeLinearEvent(basePayload, repoOwner, repoName);

      expect(event).not.toBeNull();
      expect(event!.linearStatus).toBe("In Progress");
    });

    it("extracts actor from data.creator.name", () => {
      const event = normalizeLinearEvent(basePayload, repoOwner, repoName);

      expect(event).not.toBeNull();
      expect(event!.actor).toBe("John Smith");
    });

    it("builds triggerKey containing issue id and action", () => {
      const event = normalizeLinearEvent(basePayload, repoOwner, repoName);

      expect(event).not.toBeNull();
      expect(event!.triggerKey).toContain("issue-abc");
      expect(event!.triggerKey).toContain("create");
    });

    it("builds concurrencyKey containing repoOwner/repoName and issue id", () => {
      const event = normalizeLinearEvent(basePayload, repoOwner, repoName);

      expect(event).not.toBeNull();
      expect(event!.concurrencyKey).toContain("acme-org/my-app");
      expect(event!.concurrencyKey).toContain("issue-abc");
    });

    it("produces a non-empty contextBlock", () => {
      const event = normalizeLinearEvent(basePayload, repoOwner, repoName);

      expect(event).not.toBeNull();
      expect(event!.contextBlock).toBeTruthy();
      expect(event!.contextBlock.length).toBeGreaterThan(0);
    });

    it("includes meta with issueId, identifier, and url", () => {
      const event = normalizeLinearEvent(basePayload, repoOwner, repoName);

      expect(event).not.toBeNull();
      expect(event!.meta).toMatchObject({
        issueId: "issue-abc",
        identifier: "ENG-123",
        url: "https://linear.app/acme/issue/ENG-123",
      });
    });
  });

  describe("issue updated event", () => {
    it("returns eventType issue.updated for action update", () => {
      const payload: LinearWebhookPayload = { ...basePayload, action: "update" };
      const event = normalizeLinearEvent(payload, repoOwner, repoName);

      expect(event).not.toBeNull();
      expect(event!.eventType).toBe("issue.updated");
    });

    it("includes triggerKey with update action", () => {
      const payload: LinearWebhookPayload = { ...basePayload, action: "update" };
      const event = normalizeLinearEvent(payload, repoOwner, repoName);

      expect(event).not.toBeNull();
      expect(event!.triggerKey).toContain("update");
    });
  });

  describe("issue removed event", () => {
    it("returns null for action remove", () => {
      const payload: LinearWebhookPayload = { ...basePayload, action: "remove" };
      const result = normalizeLinearEvent(payload, repoOwner, repoName);

      expect(result).toBeNull();
    });
  });

  describe("non-Issue event types", () => {
    it("returns null for Comment type", () => {
      const payload: LinearWebhookPayload = { ...basePayload, type: "Comment" };
      const result = normalizeLinearEvent(payload, repoOwner, repoName);

      expect(result).toBeNull();
    });

    it("returns null for AgentSessionEvent type", () => {
      const payload: LinearWebhookPayload = { ...basePayload, type: "AgentSessionEvent" };
      const result = normalizeLinearEvent(payload, repoOwner, repoName);

      expect(result).toBeNull();
    });

    it("returns null for Project type", () => {
      const payload: LinearWebhookPayload = { ...basePayload, type: "Project" };
      const result = normalizeLinearEvent(payload, repoOwner, repoName);

      expect(result).toBeNull();
    });
  });

  describe("missing optional fields", () => {
    it("handles event with no labels (returns undefined labels)", () => {
      const payload: LinearWebhookPayload = {
        ...basePayload,
        data: { ...basePayload.data, labels: undefined },
      };
      const event = normalizeLinearEvent(payload, repoOwner, repoName);

      expect(event).not.toBeNull();
      expect(event!.labels).toBeUndefined();
    });

    it("handles event with empty labels array (returns undefined labels)", () => {
      const payload: LinearWebhookPayload = {
        ...basePayload,
        data: { ...basePayload.data, labels: [] },
      };
      const event = normalizeLinearEvent(payload, repoOwner, repoName);

      expect(event).not.toBeNull();
      expect(event!.labels).toBeUndefined();
    });

    it("handles event with no state (linearStatus undefined)", () => {
      const payload: LinearWebhookPayload = {
        ...basePayload,
        data: { ...basePayload.data, state: undefined },
      };
      const event = normalizeLinearEvent(payload, repoOwner, repoName);

      expect(event).not.toBeNull();
      expect(event!.linearStatus).toBeUndefined();
    });

    it("handles event with no creator — falls back to assignee name for actor", () => {
      const payload: LinearWebhookPayload = {
        ...basePayload,
        data: { ...basePayload.data, creator: undefined },
      };
      const event = normalizeLinearEvent(payload, repoOwner, repoName);

      expect(event).not.toBeNull();
      expect(event!.actor).toBe("Jane Doe");
    });

    it("handles event with no creator and no assignee (actor undefined)", () => {
      const payload: LinearWebhookPayload = {
        ...basePayload,
        data: { ...basePayload.data, creator: undefined, assignee: undefined },
      };
      const event = normalizeLinearEvent(payload, repoOwner, repoName);

      expect(event).not.toBeNull();
      expect(event!.actor).toBeUndefined();
    });

    it("handles event with no url (meta.url undefined)", () => {
      const payload: LinearWebhookPayload = {
        ...basePayload,
        data: { ...basePayload.data, url: undefined },
      };
      const event = normalizeLinearEvent(payload, repoOwner, repoName);

      expect(event).not.toBeNull();
      expect(event!.meta.url).toBeUndefined();
    });

    it("does not crash with minimal required fields only", () => {
      const minimalPayload: LinearWebhookPayload = {
        type: "Issue",
        action: "create",
        organizationId: "org-1",
        webhookId: "wh-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        data: {
          id: "issue-min",
          identifier: "MIN-1",
          title: "Minimal issue",
        },
      };
      const event = normalizeLinearEvent(minimalPayload, repoOwner, repoName);

      expect(event).not.toBeNull();
      expect(event!.source).toBe("linear");
      expect(event!.eventType).toBe("issue.created");
    });
  });

  describe("label filtering", () => {
    it("labels field is an array of label name strings", () => {
      const event = normalizeLinearEvent(basePayload, repoOwner, repoName);

      expect(event).not.toBeNull();
      expect(Array.isArray(event!.labels)).toBe(true);
      event!.labels!.forEach((label) => {
        expect(typeof label).toBe("string");
      });
    });

    it("filters out labels with empty names", () => {
      const payload: LinearWebhookPayload = {
        ...basePayload,
        data: {
          ...basePayload.data,
          labels: [
            { id: "label-1", name: "bug", color: "#ff0000" },
            { id: "label-2", name: "", color: "#000000" },
            { id: "label-3", name: "valid", color: "#00ff00" },
          ],
        },
      };
      const event = normalizeLinearEvent(payload, repoOwner, repoName);

      expect(event).not.toBeNull();
      expect(event!.labels).toEqual(["bug", "valid"]);
    });
  });
});
