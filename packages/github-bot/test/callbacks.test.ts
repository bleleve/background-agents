import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeHmacHex } from "@open-inspect/shared";
import type { Logger } from "../src/logger";
import type { Env } from "../src/types";

vi.mock("../src/github-auth", () => ({
  generateInstallationToken: vi.fn().mockResolvedValue("test-installation-token"),
  findIssueCommentByMarker: vi.fn(),
  createIssueComment: vi.fn(),
}));

import {
  verifyCallbackSignature,
  handleCompleteCallback,
  type CompleteCallbackPayload,
} from "../src/callbacks";
import {
  generateInstallationToken,
  findIssueCommentByMarker,
  createIssueComment,
} from "../src/github-auth";
import { REEF_VERDICT_MARKER } from "../src/prompts";

const SECRET = "test-callback-secret";

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function createMockEnv(): Env {
  return {
    GITHUB_APP_ID: "app-id",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_APP_INSTALLATION_ID: "install-id",
    INTERNAL_CALLBACK_SECRET: SECRET,
    APP_NAME: "Reef-Test",
    WEB_APP_URL: "https://reef.test",
  } as unknown as Env;
}

const prReviewContext = {
  source: "github",
  kind: "pr_review",
  owner: "acme",
  repo: "widgets",
  prNumber: 42,
  isPublic: true,
};

/** Build a payload signed exactly the way the control-plane signs it. */
async function signedPayload(
  data: Omit<CompleteCallbackPayload, "signature">
): Promise<CompleteCallbackPayload> {
  const signature = await computeHmacHex(JSON.stringify(data), SECRET);
  return { ...data, signature };
}

beforeEach(() => {
  vi.mocked(generateInstallationToken).mockClear().mockResolvedValue("test-installation-token");
  vi.mocked(findIssueCommentByMarker).mockReset();
  vi.mocked(createIssueComment).mockReset();
});

describe("verifyCallbackSignature", () => {
  it("accepts a payload signed with the shared secret", async () => {
    const payload = await signedPayload({
      sessionId: "s1",
      messageId: "m1",
      success: true,
      timestamp: 123,
      context: prReviewContext,
    });
    expect(await verifyCallbackSignature(payload, SECRET)).toBe(true);
  });

  it("rejects a tampered field", async () => {
    const payload = await signedPayload({
      sessionId: "s1",
      messageId: "m1",
      success: true,
      timestamp: 123,
      context: prReviewContext,
    });
    payload.sessionId = "tampered";
    expect(await verifyCallbackSignature(payload, SECRET)).toBe(false);
  });

  it("rejects a bad signature", async () => {
    const payload = await signedPayload({
      sessionId: "s1",
      messageId: "m1",
      success: true,
      timestamp: 123,
      context: prReviewContext,
    });
    payload.signature = "deadbeef";
    expect(await verifyCallbackSignature(payload, SECRET)).toBe(false);
  });
});

describe("handleCompleteCallback — verdict guarantee", () => {
  it("posts a fallback verdict when the agent left none (the repair path)", async () => {
    vi.mocked(findIssueCommentByMarker).mockResolvedValue(null);
    vi.mocked(createIssueComment).mockResolvedValue(555);
    const log = createMockLogger();

    const result = await handleCompleteCallback(createMockEnv(), log, {
      sessionId: "s1",
      messageId: "m1",
      success: true,
      timestamp: 1,
      context: prReviewContext,
      signature: "x",
    });

    expect(result.status).toBe("repaired");
    expect(createIssueComment).toHaveBeenCalledTimes(1);
    const [, owner, repo, prNumber, body] = vi.mocked(createIssueComment).mock.calls[0];
    expect(owner).toBe("acme");
    expect(repo).toBe("widgets");
    expect(prNumber).toBe(42);
    // The fallback must be marker-anchored (re-review anchor) and self-labeled.
    expect(body).toContain(REEF_VERDICT_MARKER);
    expect(body).toContain("Review verdict");
    expect(body).toContain("fallback");
    // Footer links back to the session.
    expect(body).toContain("[session](https://reef.test/session/s1)");
    expect(log.info).toHaveBeenCalledWith("verdict.repaired", expect.any(Object));
  });

  it("does NOT post when the agent already posted its own verdict", async () => {
    vi.mocked(findIssueCommentByMarker).mockResolvedValue(999);
    const log = createMockLogger();

    const result = await handleCompleteCallback(createMockEnv(), log, {
      sessionId: "s1",
      messageId: "m1",
      success: true,
      timestamp: 1,
      context: prReviewContext,
      signature: "x",
    });

    expect(result.status).toBe("present");
    expect(createIssueComment).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("verdict.present", expect.any(Object));
  });

  it("reports repair_failed when the comment POST fails (no silent loss)", async () => {
    vi.mocked(findIssueCommentByMarker).mockResolvedValue(null);
    vi.mocked(createIssueComment).mockResolvedValue(null);
    const log = createMockLogger();

    const result = await handleCompleteCallback(createMockEnv(), log, {
      sessionId: "s1",
      messageId: "m1",
      success: true,
      timestamp: 1,
      context: prReviewContext,
      signature: "x",
    });

    expect(result.status).toBe("repair_failed");
    expect(log.warn).toHaveBeenCalledWith("verdict.repair_failed", expect.any(Object));
  });

  it("uses an 'unknown risk' fallback for a failed (incomplete) review", async () => {
    vi.mocked(findIssueCommentByMarker).mockResolvedValue(null);
    vi.mocked(createIssueComment).mockResolvedValue(1);

    await handleCompleteCallback(createMockEnv(), createMockLogger(), {
      sessionId: "s1",
      messageId: "m1",
      success: false,
      timestamp: 1,
      context: prReviewContext,
      signature: "x",
    });

    const body = vi.mocked(createIssueComment).mock.calls[0][4];
    expect(body).toContain("did not finish");
  });

  it("ignores completions that are not PR reviews (no GitHub calls)", async () => {
    const result = await handleCompleteCallback(createMockEnv(), createMockLogger(), {
      sessionId: "s1",
      messageId: "m1",
      success: true,
      timestamp: 1,
      context: { source: "github", kind: "comment_action" },
      signature: "x",
    });

    expect(result.status).toBe("ignored");
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(findIssueCommentByMarker).not.toHaveBeenCalled();
    expect(createIssueComment).not.toHaveBeenCalled();
  });
});
