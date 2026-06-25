import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import {
  initNamedSession,
  openSandboxWs,
  seedSandboxAuth,
  seedSandboxAuthHash,
  seedSandboxPrevIdentity,
  queryDO,
  waitForSandboxStatus,
} from "./helpers";

const SANDBOX_TOKEN = "test-sandbox-auth-token-abc123";
const SANDBOX_ID = "sb-integration-test";

// A superseded ("previous") identity, as left behind by a respawn.
const PREV_TOKEN = "test-prev-sandbox-token-xyz789";
const PREV_ID = "sb-integration-prev";

describe("Sandbox WebSocket (via SELF.fetch)", () => {
  it("upgrade with valid auth returns 101", async () => {
    const name = `ws-sandbox-ok-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });

    const { ws, response } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });

    expect(response.status).toBe(101);
    expect(ws).not.toBeNull();
    ws!.accept();
    ws!.close();
  });

  it("upgrade with wrong token returns 401", async () => {
    const name = `ws-sandbox-badtoken-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });

    const { ws, response } = await openSandboxWs(name, {
      authToken: "wrong-token",
      sandboxId: SANDBOX_ID,
    });

    expect(response.status).toBe(401);
    expect(ws).toBeNull();
  });

  it("upgrade with wrong sandbox ID returns 403", async () => {
    const name = `ws-sandbox-badid-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });

    const { ws, response } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: "wrong-sandbox-id",
    });

    expect(response.status).toBe(403);
    expect(ws).toBeNull();
  });

  it("upgrade for stopped sandbox returns 410", async () => {
    const name = `ws-sandbox-stopped-${Date.now()}`;
    const { stub } = await initNamedSession(name);

    // Wait for init's fire-and-forget warmSandbox to fail (no Modal in test env)
    // before forcing stopped, otherwise it can race and overwrite the status.
    await waitForSandboxStatus(stub, "failed");

    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });
    await queryDO(stub, "UPDATE sandbox SET status = ?", "stopped");

    const { ws, response } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });

    expect(response.status).toBe(410);
    expect(ws).toBeNull();
  });

  it("sandbox connect sets status to ready", async () => {
    const name = `ws-sandbox-ready-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });

    // Wait for init's fire-and-forget warmSandbox to fail (no Modal in test env).
    // The spawn failure sets status to "failed" which we need to happen before
    // the WS connect sets it to "ready", otherwise the two race.
    await waitForSandboxStatus(stub, "failed");

    const { ws } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(ws).not.toBeNull();
    ws!.accept();
    await waitForSandboxStatus(stub, "ready");

    const stateRes = await stub.fetch("http://internal/internal/state");
    const state = await stateRes.json<{ sandbox: { status: string } }>();
    expect(state.sandbox.status).toBe("ready");

    ws!.close();
  });

  it("sandbox WS message is stored as event", async () => {
    const name = `ws-sandbox-event-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });

    const { ws } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(ws).not.toBeNull();
    ws!.accept();

    // Send a token event via the sandbox WebSocket
    ws!.send(
      JSON.stringify({
        type: "tool_call",
        tool: "read_file",
        args: { path: "/src/main.ts" },
        callId: "call-ws-1",
        messageId: "msg-ws-1",
        sandboxId: SANDBOX_ID,
        timestamp: Date.now() / 1000,
      })
    );

    // Allow time for the DO to process the message
    await new Promise((r) => setTimeout(r, 200));

    const events = await queryDO<{ type: string; data: string }>(
      stub,
      "SELECT type, data FROM events WHERE type = ?",
      "tool_call"
    );

    const matching = events.filter((e) => {
      const data = JSON.parse(e.data);
      return data.callId === "call-ws-1";
    });
    expect(matching.length).toBeGreaterThanOrEqual(1);

    ws!.close();
  });
});

describe("Sandbox WebSocket previous-identity grace window", () => {
  const GRACE_FUTURE = () => Date.now() + 5 * 60 * 1000;

  it("accepts a previous identity within the grace window (101) and promotes it to current", async () => {
    // Reproduces the relaunch-orphaning incident: a respawn rotated the stored
    // identity to (SANDBOX_TOKEN, SANDBOX_ID) while a healthy sandbox booted
    // under (PREV_TOKEN, PREV_ID). The older healthy box must still connect.
    const name = `ws-sandbox-prev-ok-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await waitForSandboxStatus(stub, "failed");
    await seedSandboxAuthHash(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });
    await seedSandboxPrevIdentity(stub, {
      prevAuthToken: PREV_TOKEN,
      prevSandboxId: PREV_ID,
      expiresAt: GRACE_FUTURE(),
    });

    const { ws, response } = await openSandboxWs(name, {
      authToken: PREV_TOKEN,
      sandboxId: PREV_ID,
    });

    expect(response.status).toBe(101);
    expect(ws).not.toBeNull();
    ws!.accept();

    // The connecting (previous) sandbox is adopted: the stored identity is
    // realigned to it and the prev_* slots are cleared.
    const rows = await queryDO<{ modal_sandbox_id: string; prev_modal_sandbox_id: string | null }>(
      stub,
      "SELECT modal_sandbox_id, prev_modal_sandbox_id FROM sandbox"
    );
    expect(rows[0].modal_sandbox_id).toBe(PREV_ID);
    expect(rows[0].prev_modal_sandbox_id).toBeNull();

    ws!.close();
  });

  it("accepts a previous-identity HTTP callback (verify-token) within grace", async () => {
    const name = `ws-sandbox-prev-http-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await waitForSandboxStatus(stub, "failed");
    await seedSandboxAuthHash(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });
    await seedSandboxPrevIdentity(stub, {
      prevAuthToken: PREV_TOKEN,
      prevSandboxId: PREV_ID,
      expiresAt: GRACE_FUTURE(),
    });

    // boot-progress / git-credentials authenticate via the sandbox token only
    // (no id); the previous token must be honored within grace.
    const res = await SELF.fetch(`https://test.local/sessions/${name}/boot-progress`, {
      method: "POST",
      headers: { Authorization: `Bearer ${PREV_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a previous identity past the grace window (403)", async () => {
    const name = `ws-sandbox-prev-expired-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await waitForSandboxStatus(stub, "failed");
    await seedSandboxAuthHash(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });
    await seedSandboxPrevIdentity(stub, {
      prevAuthToken: PREV_TOKEN,
      prevSandboxId: PREV_ID,
      expiresAt: Date.now() - 1000, // already expired
    });

    const { ws, response } = await openSandboxWs(name, {
      authToken: PREV_TOKEN,
      sandboxId: PREV_ID,
    });

    expect(response.status).toBe(403);
    expect(ws).toBeNull();
  });

  it("clears the previous identity once the current sandbox connects (then rejects it, 403)", async () => {
    const name = `ws-sandbox-prev-cleared-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await waitForSandboxStatus(stub, "failed");
    await seedSandboxAuthHash(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });
    await seedSandboxPrevIdentity(stub, {
      prevAuthToken: PREV_TOKEN,
      prevSandboxId: PREV_ID,
      expiresAt: GRACE_FUTURE(),
    });

    // Current sandbox connects → owns the session and clears the previous identity.
    const { ws: current } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(current).not.toBeNull();
    current!.accept();
    await waitForSandboxStatus(stub, "ready");

    const rows = await queryDO<{ prev_modal_sandbox_id: string | null }>(
      stub,
      "SELECT prev_modal_sandbox_id FROM sandbox"
    );
    expect(rows[0].prev_modal_sandbox_id).toBeNull();

    // The now-cleared previous identity no longer authenticates.
    const { ws: prev, response } = await openSandboxWs(name, {
      authToken: PREV_TOKEN,
      sandboxId: PREV_ID,
    });
    expect(response.status).toBe(403);
    expect(prev).toBeNull();

    current!.close();
  });

  it("rejects a cross-identity splice (current id + previous token, and vice versa)", async () => {
    const name = `ws-sandbox-splice-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await waitForSandboxStatus(stub, "failed");
    await seedSandboxAuthHash(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });
    await seedSandboxPrevIdentity(stub, {
      prevAuthToken: PREV_TOKEN,
      prevSandboxId: PREV_ID,
      expiresAt: GRACE_FUTURE(),
    });

    // current id + previous token → token does not match the current identity.
    const splice1 = await openSandboxWs(name, { authToken: PREV_TOKEN, sandboxId: SANDBOX_ID });
    expect(splice1.response.status).toBe(401);
    expect(splice1.ws).toBeNull();

    // previous id + current token → token does not match the previous identity.
    const splice2 = await openSandboxWs(name, { authToken: SANDBOX_TOKEN, sandboxId: PREV_ID });
    expect(splice2.response.status).toBe(401);
    expect(splice2.ws).toBeNull();
  });
});
