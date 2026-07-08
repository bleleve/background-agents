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

async function post(body: unknown, headers?: Record<string, string>): Promise<Response> {
  return SELF.fetch("https://test.local/internal/route-intent", {
    method: "POST",
    headers: headers ?? (await authHeaders()),
    body: JSON.stringify(body),
  });
}

describe("POST /internal/route-intent (D1 integration)", () => {
  beforeEach(cleanD1Tables);

  it("returns 401 without auth", async () => {
    const response = await post(
      { surface: "web", text: "do something" },
      { "Content-Type": "application/json" }
    );
    expect(response.status).toBe(401);
  });

  it("rejects an unknown surface", async () => {
    const response = await post({ surface: "bogus", text: "do something" });
    expect(response.status).toBe(400);
  });

  it("rejects a missing text field", async () => {
    const response = await post({ surface: "web" });
    expect(response.status).toBe(400);
  });

  it("rejects github_mention missing isInline", async () => {
    const response = await post({ surface: "github_mention", text: "review this", labels: [] });
    expect(response.status).toBe(400);
  });

  it("rejects slack missing candidates", async () => {
    const response = await post({ surface: "slack", text: "fix the bug" });
    expect(response.status).toBe(400);
  });

  it("rejects a slack candidate missing fullName", async () => {
    const response = await post({
      surface: "slack",
      text: "fix the bug",
      candidates: [{ id: "acme/widgets" }],
    });
    expect(response.status).toBe(400);
  });

  // No ANTHROPIC_API_KEY is bound in the integration test environment (see
  // vitest.integration.config.ts) — deliberately: exercising a real Anthropic
  // call from CI would be non-hermetic (network, cost, flakiness), and this
  // codebase has no established pattern for intercepting an SDK call inside
  // the workerd pool. What this DOES prove end-to-end, for real, through the
  // actual router + HMAC auth + D1-backed ModelPreferencesStore read: the
  // full request validates, dispatches, and returns the uniform fallback
  // shape — the exact path a real Anthropic outage would take in production.
  // The classification logic itself (all 4 surfaces, all fallback reasons,
  // model substitution) is covered by the mocked-SDK unit tests in
  // src/routing/intent-classifier.test.ts.
  it("round-trips a github_mention request end-to-end to a no_api_key fallback", async () => {
    const response = await post({
      surface: "github_mention",
      text: "please review this PR",
      isInline: false,
      labels: ["plan"],
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      surface: "github_mention",
      source: "fallback",
      fallbackReason: "no_api_key",
    });
  });

  it("round-trips a slack request end-to-end to a no_api_key fallback", async () => {
    const response = await post({
      surface: "slack",
      text: "fix the widgets bug",
      candidates: [{ id: "acme/widgets", fullName: "acme/widgets" }],
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ surface: "slack", source: "fallback", fallbackReason: "no_api_key" });
  });

  it("round-trips a linear request end-to-end to a no_api_key fallback", async () => {
    const response = await post({
      surface: "linear",
      text: "redesign the module",
      title: "Redesign",
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ surface: "linear", source: "fallback", fallbackReason: "no_api_key" });
  });

  it("round-trips a web request end-to-end to a no_api_key fallback", async () => {
    const response = await post({ surface: "web", text: "fix the typo" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ surface: "web", source: "fallback", fallbackReason: "no_api_key" });
  });
});
