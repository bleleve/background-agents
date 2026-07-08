import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateSessionInput } from "@open-inspect/shared";
import type { Logger } from "@open-inspect/shared";
import type { Env } from "../types";
import type { RequestContext } from "./shared";

const { mockClassifyIntent } = vi.hoisted(() => ({
  mockClassifyIntent: vi.fn(),
}));

vi.mock("../routing/intent-classifier", () => ({
  classifyIntent: mockClassifyIntent,
}));

import { classificationSurfaceFor, resolvePlanMode } from "./session-create";

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return { ...overrides } as Env;
}

function createBody(overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    spawnSource: "linear-bot",
    planClassificationText: "please add a small config flag",
    ...overrides,
  } as CreateSessionInput;
}

const ctx = { trace_id: "trace-1", request_id: "req-1" } as unknown as RequestContext;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("classificationSurfaceFor", () => {
  it("maps linear-bot to the linear surface", () => {
    expect(classificationSurfaceFor("linear-bot")).toBe("linear");
  });

  it("maps user to the web surface", () => {
    expect(classificationSurfaceFor("user")).toBe("web");
  });

  it.each(["github-bot", "slack-bot", "agent", "automation", undefined] as const)(
    "returns null for %s (resolved elsewhere or not a free-text request)",
    (spawnSource) => {
      expect(classificationSurfaceFor(spawnSource)).toBeNull();
    }
  );
});

describe("resolvePlanMode", () => {
  it("returns the explicit value unchanged when planMode is set, without calling the classifier", async () => {
    const log = createMockLogger();
    await resolvePlanMode(createEnv(), log, createBody({ planMode: true }), ctx);
    await resolvePlanMode(createEnv(), log, createBody({ planMode: false }), ctx);
    expect(mockClassifyIntent).not.toHaveBeenCalled();
  });

  it("resolves the exact explicit boolean", async () => {
    const log = createMockLogger();
    expect(await resolvePlanMode(createEnv(), log, createBody({ planMode: true }), ctx)).toBe(true);
    expect(await resolvePlanMode(createEnv(), log, createBody({ planMode: false }), ctx)).toBe(
      false
    );
  });

  it("defaults to false when planMode is omitted and the spawnSource isn't a covered surface", async () => {
    const log = createMockLogger();
    const result = await resolvePlanMode(
      createEnv(),
      log,
      createBody({ planMode: undefined, spawnSource: "github-bot" }),
      ctx
    );
    expect(result).toBe(false);
    expect(mockClassifyIntent).not.toHaveBeenCalled();
  });

  it("defaults to false when planMode is omitted and there is no classification text", async () => {
    const log = createMockLogger();
    const result = await resolvePlanMode(
      createEnv(),
      log,
      createBody({ planMode: undefined, planClassificationText: undefined }),
      ctx
    );
    expect(result).toBe(false);
    expect(mockClassifyIntent).not.toHaveBeenCalled();
  });

  it("shadow mode (default): classifies, logs the divergence, but always returns false", async () => {
    const log = createMockLogger();
    mockClassifyIntent.mockResolvedValue({
      surface: "linear",
      source: "classifier",
      mode: "plan",
      confidence: "high",
    });

    const result = await resolvePlanMode(
      createEnv({ INTENT_ROUTER_MODE_SESSION_CREATE: undefined }),
      log,
      createBody({ planMode: undefined }),
      ctx
    );

    expect(result).toBe(false);
    expect(mockClassifyIntent).toHaveBeenCalledWith(
      expect.anything(),
      log,
      { surface: "linear", text: "please add a small config flag", title: undefined },
      { trace_id: "trace-1", request_id: "req-1" }
    );
    expect(log.info).toHaveBeenCalledWith(
      "intent_router.shadow",
      expect.objectContaining({
        surface: "linear",
        inferred_mode: "plan",
        acted_mode: "direct",
        diverged: true,
      })
    );
  });

  it('classifier mode ("classifier"): acts on the inferred mode', async () => {
    const log = createMockLogger();
    mockClassifyIntent.mockResolvedValue({
      surface: "web",
      source: "classifier",
      mode: "plan",
      confidence: "high",
    });

    const result = await resolvePlanMode(
      createEnv({ INTENT_ROUTER_MODE_SESSION_CREATE: "classifier" }),
      log,
      createBody({ planMode: undefined, spawnSource: "user" }),
      ctx
    );

    expect(result).toBe(true);
  });

  it('classifier mode with an inferred "direct" result stays false', async () => {
    const log = createMockLogger();
    mockClassifyIntent.mockResolvedValue({
      surface: "linear",
      source: "classifier",
      mode: "direct",
      confidence: "high",
    });

    const result = await resolvePlanMode(
      createEnv({ INTENT_ROUTER_MODE_SESSION_CREATE: "classifier" }),
      log,
      createBody({ planMode: undefined }),
      ctx
    );

    expect(result).toBe(false);
  });

  it("falls back to false regardless of mode when the classifier returns a fallback response", async () => {
    const log = createMockLogger();
    mockClassifyIntent.mockResolvedValue({
      surface: "linear",
      source: "fallback",
      fallbackReason: "timeout",
    });

    const result = await resolvePlanMode(
      createEnv({ INTENT_ROUTER_MODE_SESSION_CREATE: "classifier" }),
      log,
      createBody({ planMode: undefined }),
      ctx
    );

    expect(result).toBe(false);
  });
});
