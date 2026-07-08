import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@open-inspect/shared";
import type { Env } from "../types";

const { mockMessagesCreate, mockGetPreferences } = vi.hoisted(() => ({
  mockMessagesCreate: vi.fn(),
  mockGetPreferences: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  // vitest 4 only treats function/class implementations as constructable; an
  // arrow function here throws "is not a constructor" on `new Anthropic()`.
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockMessagesCreate } };
  }),
}));

vi.mock("../db/model-preferences", () => ({
  ModelPreferencesStore: vi.fn().mockImplementation(function () {
    return { getPreferences: mockGetPreferences };
  }),
}));

import { classifyIntent } from "./intent-classifier";

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
  return {
    DB: {} as D1Database,
    ANTHROPIC_API_KEY: "sk-test-key",
    ...overrides,
  } as Env;
}

function toolUseResponse(input: Record<string, unknown>) {
  return {
    stop_reason: "tool_use",
    content: [{ type: "tool_use", name: "classify_intent", input }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPreferences.mockResolvedValue({
    enabledModels: [],
    defaultModel: null,
    defaultPlanModel: null,
    defaultRoutingModel: "anthropic/claude-haiku-4-5",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("classifyIntent — github_mention surface", () => {
  it("returns a classifier result on the happy path", async () => {
    mockMessagesCreate.mockResolvedValue(
      toolUseResponse({
        target: "request",
        confidence: "high",
        reasoning: "asks for a change",
        shouldPlan: false,
        planReasoning: "small fix",
      })
    );
    const log = createMockLogger();

    const result = await classifyIntent(createEnv(), log, {
      surface: "github_mention",
      text: "please fix the off-by-one in the loop",
      isInline: false,
      labels: [],
    });

    expect(result).toEqual({
      surface: "github_mention",
      source: "classifier",
      target: "request",
      mode: "direct",
      confidence: "high",
    });
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5", temperature: 0 }),
      expect.objectContaining({ timeout: 3_000 })
    );
    expect(log.info).toHaveBeenCalledWith(
      "intent_router.decision",
      expect.objectContaining({
        surface: "github_mention",
        source: "classifier",
        target: "request",
      })
    );
  });

  it("maps target=review with shouldPlan=true to a request/plan result correctly", async () => {
    mockMessagesCreate.mockResolvedValue(
      toolUseResponse({
        target: "review",
        confidence: "high",
        reasoning: "ptal",
        shouldPlan: true,
        planReasoning: "irrelevant for review",
      })
    );

    const result = await classifyIntent(createEnv(), createMockLogger(), {
      surface: "github_mention",
      text: "PTAL",
      isInline: false,
      labels: [],
    });

    expect(result).toMatchObject({ target: "review", mode: "plan" });
  });
});

describe("classifyIntent — slack surface", () => {
  it("classifies among multiple candidates using the full tool", async () => {
    mockMessagesCreate.mockResolvedValue(
      toolUseResponse({
        repoId: "acme/widgets",
        confidence: "high",
        reasoning: "explicit mention",
        alternatives: [],
        shouldPlan: true,
        planReasoning: "multi-file refactor",
      })
    );

    const result = await classifyIntent(createEnv(), createMockLogger(), {
      surface: "slack",
      text: "refactor the widgets auth flow",
      candidates: [
        { id: "acme/widgets", fullName: "acme/widgets" },
        { id: "acme/gadgets", fullName: "acme/gadgets" },
      ],
    });

    expect(result).toEqual({
      surface: "slack",
      source: "classifier",
      repoId: "acme/widgets",
      confidence: "high",
      alternatives: [],
      mode: "plan",
      needsClarification: false,
    });
  });

  it("uses the cheaper mode-only tool when there is at most one candidate", async () => {
    mockMessagesCreate.mockResolvedValue(
      toolUseResponse({ confidence: "high", shouldPlan: false, planReasoning: "quick tweak" })
    );

    const result = await classifyIntent(createEnv(), createMockLogger(), {
      surface: "slack",
      text: "bump the timeout to 30s",
      candidates: [{ id: "acme/widgets", fullName: "acme/widgets" }],
    });

    expect(result).toEqual({
      surface: "slack",
      source: "classifier",
      repoId: "acme/widgets",
      confidence: "high",
      alternatives: [],
      mode: "direct",
      needsClarification: false,
    });
    // Mode-only tool: no repo classification prompt, no repository list built.
    expect(mockMessagesCreate.mock.calls[0][0].tools[0].name).toBe("classify_intent");
    expect(mockMessagesCreate.mock.calls[0][0].tools[0].input_schema.required).not.toContain(
      "repoId"
    );
  });

  it("needs clarification when there are zero candidates", async () => {
    mockMessagesCreate.mockResolvedValue(
      toolUseResponse({ confidence: "low", shouldPlan: false, planReasoning: "no repo context" })
    );

    const result = await classifyIntent(createEnv(), createMockLogger(), {
      surface: "slack",
      text: "fix the bug",
      candidates: [],
    });

    expect(result).toMatchObject({ repoId: null, needsClarification: true });
  });
});

describe("classifyIntent — linear / web surfaces", () => {
  it("classifies mode for linear", async () => {
    mockMessagesCreate.mockResolvedValue(
      toolUseResponse({ confidence: "medium", shouldPlan: true, planReasoning: "architectural" })
    );

    const result = await classifyIntent(createEnv(), createMockLogger(), {
      surface: "linear",
      text: "redesign the auth module",
      title: "Redesign auth",
    });

    expect(result).toEqual({
      surface: "linear",
      source: "classifier",
      mode: "plan",
      confidence: "medium",
    });
  });

  it("classifies mode for web", async () => {
    mockMessagesCreate.mockResolvedValue(
      toolUseResponse({ confidence: "high", shouldPlan: false, planReasoning: "typo fix" })
    );

    const result = await classifyIntent(createEnv(), createMockLogger(), {
      surface: "web",
      text: "fix typo in README",
    });

    expect(result).toEqual({
      surface: "web",
      source: "classifier",
      mode: "direct",
      confidence: "high",
    });
  });
});

describe("classifyIntent — fallback paths", () => {
  it("falls back with no_api_key when the API key is missing, without calling the SDK", async () => {
    const log = createMockLogger();
    const result = await classifyIntent(createEnv({ ANTHROPIC_API_KEY: undefined }), log, {
      surface: "web",
      text: "do something",
    });

    expect(result).toEqual({ surface: "web", source: "fallback", fallbackReason: "no_api_key" });
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("falls back with invalid_output on a malformed tool response", async () => {
    mockMessagesCreate.mockResolvedValue(
      toolUseResponse({ confidence: "not-a-level", shouldPlan: false, planReasoning: "x" })
    );

    const result = await classifyIntent(createEnv(), createMockLogger(), {
      surface: "web",
      text: "do something",
    });

    expect(result).toEqual({
      surface: "web",
      source: "fallback",
      fallbackReason: "invalid_output",
    });
  });

  it("falls back with invalid_output when stop_reason isn't tool_use", async () => {
    mockMessagesCreate.mockResolvedValue({ stop_reason: "end_turn", content: [] });

    const result = await classifyIntent(createEnv(), createMockLogger(), {
      surface: "web",
      text: "do something",
    });

    expect(result).toEqual({
      surface: "web",
      source: "fallback",
      fallbackReason: "invalid_output",
    });
  });

  it("falls back with api_error when the SDK call throws", async () => {
    mockMessagesCreate.mockRejectedValue(new Error("529 overloaded"));

    const result = await classifyIntent(createEnv(), createMockLogger(), {
      surface: "web",
      text: "do something",
    });

    expect(result).toEqual({ surface: "web", source: "fallback", fallbackReason: "api_error" });
  });

  it("falls back with timeout when the call exceeds the budget", async () => {
    vi.useFakeTimers();
    mockMessagesCreate.mockImplementation(() => new Promise(() => {})); // never resolves

    const promise = classifyIntent(createEnv(), createMockLogger(), {
      surface: "web",
      text: "do something",
    });
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await promise;

    expect(result).toEqual({ surface: "web", source: "fallback", fallbackReason: "timeout" });
  });
});

describe("classifyIntent — routing model resolution", () => {
  it("substitutes the default model when the configured routing model isn't Anthropic", async () => {
    mockGetPreferences.mockResolvedValue({
      enabledModels: [],
      defaultModel: null,
      defaultPlanModel: null,
      defaultRoutingModel: "openai/gpt-5",
    });
    mockMessagesCreate.mockResolvedValue(
      toolUseResponse({ confidence: "high", shouldPlan: false, planReasoning: "x" })
    );
    const log = createMockLogger();

    const result = await classifyIntent(createEnv(), log, { surface: "web", text: "do something" });

    expect(result.source).toBe("classifier");
    expect(mockMessagesCreate.mock.calls[0][0].model).toBe("claude-haiku-4-5");
    expect(log.warn).toHaveBeenCalledWith(
      "intent_router.non_anthropic_model",
      expect.objectContaining({ configured_model: "openai/gpt-5" })
    );
  });
});

describe("classifyIntent — content hygiene", () => {
  it("never logs the raw request text or model reasoning", async () => {
    const secretText = "please rewrite the auth token handshake flow, it leaks session ids";
    mockMessagesCreate.mockResolvedValue(
      toolUseResponse({
        confidence: "high",
        shouldPlan: true,
        planReasoning: "leaks the exact secret text back in reasoning: " + secretText,
      })
    );
    const log = createMockLogger();

    await classifyIntent(createEnv(), log, { surface: "web", text: secretText });

    const infoCalls = JSON.stringify((log.info as ReturnType<typeof vi.fn>).mock.calls);
    const warnCalls = JSON.stringify((log.warn as ReturnType<typeof vi.fn>).mock.calls);
    expect(infoCalls).not.toContain(secretText);
    expect(warnCalls).not.toContain(secretText);
  });
});
