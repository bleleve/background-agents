import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { generateInternalToken } from "../../src/auth/internal";
import { cleanD1Tables } from "./cleanup";

async function authHeaders(): Promise<Record<string, string>> {
  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

interface PreambleRuleResponse {
  id: string;
  source: "slack" | "github" | "linear" | "default";
  matcher: Record<string, unknown>;
  preamble: string;
  priority: number;
  enabled: boolean;
  suggestsSessionType: "telemetry" | null;
}

interface ResolveResponse {
  preambles: string[];
  suggestedSessionType?: "telemetry";
}

async function createRule(
  body: Record<string, unknown>
): Promise<{ status: number; body: PreambleRuleResponse | { error: string } }> {
  const headers = await authHeaders();
  const response = await SELF.fetch("https://test.local/preamble-rules", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe("Preamble rules API", () => {
  beforeEach(cleanD1Tables);

  describe("POST /preamble-rules", () => {
    it("creates a rule with channel_name_regex matcher", async () => {
      const result = await createRule({
        source: "slack",
        matcher: { type: "channel_name_regex", pattern: "-alerts$" },
        preamble: "Query observability MCPs first.",
        priority: 80,
      });
      expect(result.status).toBe(201);
      const rule = result.body as PreambleRuleResponse;
      expect(rule.id).toBeTruthy();
      expect(rule.source).toBe("slack");
      expect(rule.matcher).toEqual({ type: "channel_name_regex", pattern: "-alerts$" });
      expect(rule.preamble).toBe("Query observability MCPs first.");
      expect(rule.priority).toBe(80);
      expect(rule.enabled).toBe(true);
      expect(rule.suggestsSessionType).toBeNull();
    });

    it("creates a rule with always matcher (default source)", async () => {
      const result = await createRule({
        source: "default",
        matcher: { type: "always" },
        preamble: "Anti-rabbit-hole heuristic.",
        priority: 100,
        suggestsSessionType: null,
      });
      expect(result.status).toBe(201);
      expect((result.body as PreambleRuleResponse).source).toBe("default");
    });

    it("creates a rule with suggestsSessionType=telemetry", async () => {
      const result = await createRule({
        source: "slack",
        matcher: { type: "channel_name_regex", pattern: "^wx-cloudops-high-alerts$" },
        preamble: "Telemetry triage.",
        suggestsSessionType: "telemetry",
      });
      expect(result.status).toBe(201);
      expect((result.body as PreambleRuleResponse).suggestsSessionType).toBe("telemetry");
    });

    it("rejects invalid source", async () => {
      const result = await createRule({
        source: "telegram",
        matcher: { type: "always" },
        preamble: "x",
      });
      expect(result.status).toBe(400);
    });

    it("rejects empty preamble", async () => {
      const result = await createRule({
        source: "slack",
        matcher: { type: "always" },
        preamble: "  ",
      });
      expect(result.status).toBe(400);
    });

    it("rejects invalid matcher type", async () => {
      const result = await createRule({
        source: "slack",
        matcher: { type: "nonsense" },
        preamble: "x",
      });
      expect(result.status).toBe(400);
    });

    it("rejects channel_name_regex with empty pattern", async () => {
      const result = await createRule({
        source: "slack",
        matcher: { type: "channel_name_regex", pattern: "" },
        preamble: "x",
      });
      expect(result.status).toBe(400);
    });

    it("rejects channel_name_regex with invalid pattern", async () => {
      const result = await createRule({
        source: "slack",
        matcher: { type: "channel_name_regex", pattern: "[invalid(" },
        preamble: "x",
      });
      expect(result.status).toBe(400);
    });

    it("rejects channel_description_contains with no keywords", async () => {
      const result = await createRule({
        source: "slack",
        matcher: { type: "channel_description_contains", keywords: [] },
        preamble: "x",
      });
      expect(result.status).toBe(400);
    });

    it("rejects repo_full_name without slash", async () => {
      const result = await createRule({
        source: "github",
        matcher: { type: "repo_full_name", value: "no-slash-here" },
        preamble: "x",
      });
      expect(result.status).toBe(400);
    });

    it("rejects suggestsSessionType other than 'telemetry'", async () => {
      const result = await createRule({
        source: "slack",
        matcher: { type: "always" },
        preamble: "x",
        suggestsSessionType: "full",
      });
      expect(result.status).toBe(400);
    });

    it("returns 401 without auth", async () => {
      const response = await SELF.fetch("https://test.local/preamble-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "slack",
          matcher: { type: "always" },
          preamble: "x",
        }),
      });
      expect(response.status).toBe(401);
    });
  });

  describe("GET /preamble-rules", () => {
    it("lists all rules ordered by priority desc, id asc", async () => {
      await createRule({
        source: "slack",
        matcher: { type: "always" },
        preamble: "low",
        priority: 10,
      });
      await createRule({
        source: "slack",
        matcher: { type: "always" },
        preamble: "high",
        priority: 50,
      });

      const headers = await authHeaders();
      const response = await SELF.fetch("https://test.local/preamble-rules", { headers });
      expect(response.status).toBe(200);
      const body = (await response.json()) as PreambleRuleResponse[];
      expect(body).toHaveLength(2);
      expect(body[0].preamble).toBe("high");
      expect(body[1].preamble).toBe("low");
    });

    it("filters by source query param", async () => {
      await createRule({
        source: "slack",
        matcher: { type: "always" },
        preamble: "slack-rule",
      });
      await createRule({
        source: "github",
        matcher: { type: "always" },
        preamble: "github-rule",
      });

      const headers = await authHeaders();
      const response = await SELF.fetch("https://test.local/preamble-rules?source=slack", {
        headers,
      });
      const body = (await response.json()) as PreambleRuleResponse[];
      expect(body).toHaveLength(1);
      expect(body[0].preamble).toBe("slack-rule");
    });

    it("returns 400 for invalid source filter", async () => {
      const headers = await authHeaders();
      const response = await SELF.fetch("https://test.local/preamble-rules?source=bogus", {
        headers,
      });
      expect(response.status).toBe(400);
    });
  });

  describe("GET /preamble-rules/:id", () => {
    it("returns a rule by id", async () => {
      const create = await createRule({
        source: "slack",
        matcher: { type: "always" },
        preamble: "x",
      });
      const created = create.body as PreambleRuleResponse;
      const headers = await authHeaders();
      const response = await SELF.fetch(`https://test.local/preamble-rules/${created.id}`, {
        headers,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as PreambleRuleResponse;
      expect(body.id).toBe(created.id);
    });

    it("returns 404 for missing rule", async () => {
      const headers = await authHeaders();
      const response = await SELF.fetch("https://test.local/preamble-rules/nope", { headers });
      expect(response.status).toBe(404);
    });
  });

  describe("PUT /preamble-rules/:id", () => {
    it("updates preamble text and priority", async () => {
      const create = await createRule({
        source: "slack",
        matcher: { type: "always" },
        preamble: "old",
        priority: 10,
      });
      const created = create.body as PreambleRuleResponse;

      const headers = await authHeaders();
      const response = await SELF.fetch(`https://test.local/preamble-rules/${created.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ preamble: "new", priority: 99 }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as PreambleRuleResponse;
      expect(body.preamble).toBe("new");
      expect(body.priority).toBe(99);
    });

    it("clears suggestsSessionType when sent as null", async () => {
      const create = await createRule({
        source: "slack",
        matcher: { type: "always" },
        preamble: "x",
        suggestsSessionType: "telemetry",
      });
      const created = create.body as PreambleRuleResponse;
      expect(created.suggestsSessionType).toBe("telemetry");

      const headers = await authHeaders();
      const response = await SELF.fetch(`https://test.local/preamble-rules/${created.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ suggestsSessionType: null }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as PreambleRuleResponse;
      expect(body.suggestsSessionType).toBeNull();
    });

    it("toggles enabled flag", async () => {
      const create = await createRule({
        source: "slack",
        matcher: { type: "always" },
        preamble: "x",
      });
      const created = create.body as PreambleRuleResponse;

      const headers = await authHeaders();
      const response = await SELF.fetch(`https://test.local/preamble-rules/${created.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ enabled: false }),
      });
      const body = (await response.json()) as PreambleRuleResponse;
      expect(body.enabled).toBe(false);
    });

    it("returns 404 for missing rule", async () => {
      const headers = await authHeaders();
      const response = await SELF.fetch("https://test.local/preamble-rules/nope", {
        method: "PUT",
        headers,
        body: JSON.stringify({ preamble: "x" }),
      });
      expect(response.status).toBe(404);
    });

    it("rejects invalid matcher on update", async () => {
      const create = await createRule({
        source: "slack",
        matcher: { type: "always" },
        preamble: "x",
      });
      const created = create.body as PreambleRuleResponse;

      const headers = await authHeaders();
      const response = await SELF.fetch(`https://test.local/preamble-rules/${created.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ matcher: { type: "bogus" } }),
      });
      expect(response.status).toBe(400);
    });
  });

  describe("DELETE /preamble-rules/:id", () => {
    it("deletes a rule", async () => {
      const create = await createRule({
        source: "slack",
        matcher: { type: "always" },
        preamble: "x",
      });
      const created = create.body as PreambleRuleResponse;

      const headers = await authHeaders();
      const response = await SELF.fetch(`https://test.local/preamble-rules/${created.id}`, {
        method: "DELETE",
        headers,
      });
      expect(response.status).toBe(200);

      const getResponse = await SELF.fetch(`https://test.local/preamble-rules/${created.id}`, {
        headers,
      });
      expect(getResponse.status).toBe(404);
    });

    it("returns 404 for missing rule", async () => {
      const headers = await authHeaders();
      const response = await SELF.fetch("https://test.local/preamble-rules/nope", {
        method: "DELETE",
        headers,
      });
      expect(response.status).toBe(404);
    });
  });

  describe("POST /preambles/resolve", () => {
    it("returns matching slack preamble for channel_name_regex", async () => {
      await createRule({
        source: "slack",
        matcher: { type: "channel_name_regex", pattern: "^wx-cloudops-high-alerts$" },
        preamble: "telemetry first",
        priority: 80,
        suggestsSessionType: "telemetry",
      });

      const headers = await authHeaders();
      const response = await SELF.fetch("https://test.local/preambles/resolve", {
        method: "POST",
        headers,
        body: JSON.stringify({ source: "slack", channelName: "wx-cloudops-high-alerts" }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as ResolveResponse;
      expect(body.preambles).toEqual(["telemetry first"]);
      expect(body.suggestedSessionType).toBe("telemetry");
    });

    it("returns default-source preambles for any context source", async () => {
      await createRule({
        source: "default",
        matcher: { type: "always" },
        preamble: "applies everywhere",
        priority: 100,
      });

      const headers = await authHeaders();
      const response = await SELF.fetch("https://test.local/preambles/resolve", {
        method: "POST",
        headers,
        body: JSON.stringify({ source: "linear", linearTeamKey: "ENG" }),
      });
      const body = (await response.json()) as ResolveResponse;
      expect(body.preambles).toContain("applies everywhere");
    });

    it("orders results: source-specific high priority before default low priority", async () => {
      await createRule({
        source: "default",
        matcher: { type: "always" },
        preamble: "default-low",
        priority: 10,
      });
      await createRule({
        source: "slack",
        matcher: { type: "always" },
        preamble: "slack-high",
        priority: 90,
      });

      const headers = await authHeaders();
      const response = await SELF.fetch("https://test.local/preambles/resolve", {
        method: "POST",
        headers,
        body: JSON.stringify({ source: "slack" }),
      });
      const body = (await response.json()) as ResolveResponse;
      expect(body.preambles).toEqual(["slack-high", "default-low"]);
    });

    it("excludes disabled rules from resolve", async () => {
      const created = await createRule({
        source: "slack",
        matcher: { type: "always" },
        preamble: "disabled-rule",
      });
      const rule = created.body as PreambleRuleResponse;
      const headers = await authHeaders();
      await SELF.fetch(`https://test.local/preamble-rules/${rule.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ enabled: false }),
      });

      const response = await SELF.fetch("https://test.local/preambles/resolve", {
        method: "POST",
        headers,
        body: JSON.stringify({ source: "slack" }),
      });
      const body = (await response.json()) as ResolveResponse;
      expect(body.preambles).toEqual([]);
    });

    it("returns 400 for invalid source in resolve body", async () => {
      const headers = await authHeaders();
      const response = await SELF.fetch("https://test.local/preambles/resolve", {
        method: "POST",
        headers,
        body: JSON.stringify({ source: "bogus" }),
      });
      expect(response.status).toBe(400);
    });

    it("returns empty result when no rules match", async () => {
      const headers = await authHeaders();
      const response = await SELF.fetch("https://test.local/preambles/resolve", {
        method: "POST",
        headers,
        body: JSON.stringify({ source: "slack", channelName: "no-rules-channel" }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as ResolveResponse;
      expect(body.preambles).toEqual([]);
      expect(body.suggestedSessionType).toBeUndefined();
    });
  });
});
