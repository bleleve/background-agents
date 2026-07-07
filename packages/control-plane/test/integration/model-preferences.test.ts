import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  ModelPreferencesStore,
  ModelPreferencesValidationError,
} from "../../src/db/model-preferences";
import { cleanD1Tables } from "./cleanup";

describe("ModelPreferencesStore (D1 integration)", () => {
  beforeEach(cleanD1Tables);

  it("returns null when no row has been written yet", async () => {
    const store = new ModelPreferencesStore(env.DB);
    expect(await store.getPreferences()).toBeNull();
    expect(await store.getEnabledModels()).toBeNull();
  });

  it("upserts the singleton row and round-trips all fields", async () => {
    const store = new ModelPreferencesStore(env.DB);

    await store.setPreferences({
      enabledModels: ["anthropic/claude-haiku-4-5", "anthropic/claude-opus-4-6"],
      defaultModel: "anthropic/claude-haiku-4-5",
      defaultPlanModel: "anthropic/claude-opus-4-6",
      defaultRoutingModel: "anthropic/claude-haiku-4-5",
    });

    expect(await store.getPreferences()).toEqual({
      enabledModels: ["anthropic/claude-haiku-4-5", "anthropic/claude-opus-4-6"],
      defaultModel: "anthropic/claude-haiku-4-5",
      defaultPlanModel: "anthropic/claude-opus-4-6",
      defaultRoutingModel: "anthropic/claude-haiku-4-5",
    });
  });

  it("persists null defaults (= delegate to env/shared fallback)", async () => {
    const store = new ModelPreferencesStore(env.DB);

    await store.setPreferences({
      enabledModels: ["anthropic/claude-haiku-4-5"],
      defaultModel: null,
      defaultPlanModel: null,
      defaultRoutingModel: null,
    });

    const prefs = await store.getPreferences();
    expect(prefs).toEqual({
      enabledModels: ["anthropic/claude-haiku-4-5"],
      defaultModel: null,
      defaultPlanModel: null,
      defaultRoutingModel: null,
    });
  });

  it("overwrites existing values on the second setPreferences call (upsert)", async () => {
    const store = new ModelPreferencesStore(env.DB);

    await store.setPreferences({
      enabledModels: ["anthropic/claude-haiku-4-5"],
      defaultModel: "anthropic/claude-haiku-4-5",
      defaultPlanModel: null,
      defaultRoutingModel: "anthropic/claude-haiku-4-5",
    });
    await store.setPreferences({
      enabledModels: ["anthropic/claude-opus-4-7"],
      defaultModel: "anthropic/claude-opus-4-7",
      defaultPlanModel: "anthropic/claude-opus-4-7",
      defaultRoutingModel: "anthropic/claude-opus-4-7",
    });

    expect(await store.getPreferences()).toEqual({
      enabledModels: ["anthropic/claude-opus-4-7"],
      defaultModel: "anthropic/claude-opus-4-7",
      defaultPlanModel: "anthropic/claude-opus-4-7",
      defaultRoutingModel: "anthropic/claude-opus-4-7",
    });
  });

  it("dedupes enabledModels", async () => {
    const store = new ModelPreferencesStore(env.DB);
    await store.setPreferences({
      enabledModels: [
        "anthropic/claude-haiku-4-5",
        "anthropic/claude-haiku-4-5",
        "anthropic/claude-opus-4-6",
      ],
      defaultModel: null,
      defaultPlanModel: null,
      defaultRoutingModel: null,
    });
    expect((await store.getPreferences())?.enabledModels).toEqual([
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-opus-4-6",
    ]);
  });

  it("rejects empty enabledModels", async () => {
    const store = new ModelPreferencesStore(env.DB);
    await expect(
      store.setPreferences({
        enabledModels: [],
        defaultModel: null,
        defaultPlanModel: null,
        defaultRoutingModel: null,
      })
    ).rejects.toBeInstanceOf(ModelPreferencesValidationError);
  });

  it("rejects invalid model ids in enabledModels", async () => {
    const store = new ModelPreferencesStore(env.DB);
    await expect(
      store.setPreferences({
        enabledModels: ["not-a-real-model"],
        defaultModel: null,
        defaultPlanModel: null,
        defaultRoutingModel: null,
      })
    ).rejects.toBeInstanceOf(ModelPreferencesValidationError);
  });

  it("rejects a defaultModel that is not in enabledModels", async () => {
    const store = new ModelPreferencesStore(env.DB);
    await expect(
      store.setPreferences({
        enabledModels: ["anthropic/claude-haiku-4-5"],
        defaultModel: "anthropic/claude-opus-4-7",
        defaultPlanModel: null,
        defaultRoutingModel: null,
      })
    ).rejects.toThrow(/not in the enabled models list/);
  });

  it("rejects a defaultPlanModel that is not in enabledModels", async () => {
    const store = new ModelPreferencesStore(env.DB);
    await expect(
      store.setPreferences({
        enabledModels: ["anthropic/claude-haiku-4-5"],
        defaultModel: null,
        defaultPlanModel: "anthropic/claude-opus-4-7",
        defaultRoutingModel: null,
      })
    ).rejects.toThrow(/not in the enabled models list/);
  });

  it("rejects a defaultRoutingModel that is not in enabledModels", async () => {
    const store = new ModelPreferencesStore(env.DB);
    await expect(
      store.setPreferences({
        enabledModels: ["anthropic/claude-haiku-4-5"],
        defaultModel: null,
        defaultPlanModel: null,
        defaultRoutingModel: "anthropic/claude-opus-4-7",
      })
    ).rejects.toThrow(/not in the enabled models list/);
  });

  it("rejects an invalid defaultRoutingModel id", async () => {
    const store = new ModelPreferencesStore(env.DB);
    await expect(
      store.setPreferences({
        enabledModels: ["anthropic/claude-haiku-4-5"],
        defaultModel: null,
        defaultPlanModel: null,
        defaultRoutingModel: "garbage",
      })
    ).rejects.toThrow(/Invalid default routing model ID/);
  });

  it("rejects an invalid defaultModel id", async () => {
    const store = new ModelPreferencesStore(env.DB);
    await expect(
      store.setPreferences({
        enabledModels: ["anthropic/claude-haiku-4-5"],
        defaultModel: "garbage",
        defaultPlanModel: null,
        defaultRoutingModel: null,
      })
    ).rejects.toThrow(/Invalid default model ID/);
  });

  it("getEnabledModels returns just the array for back-compat", async () => {
    const store = new ModelPreferencesStore(env.DB);
    await store.setPreferences({
      enabledModels: ["anthropic/claude-haiku-4-5", "anthropic/claude-opus-4-6"],
      defaultModel: "anthropic/claude-haiku-4-5",
      defaultPlanModel: null,
      defaultRoutingModel: null,
    });
    expect(await store.getEnabledModels()).toEqual([
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-opus-4-6",
    ]);
  });
});
