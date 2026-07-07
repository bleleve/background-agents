import { isValidModel } from "@open-inspect/shared";

export class ModelPreferencesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelPreferencesValidationError";
  }
}

export interface ModelPreferences {
  enabledModels: string[];
  defaultModel: string | null;
  defaultPlanModel: string | null;
  /** Model reserved for the future @mention router; null = delegate to env/shared fallback. */
  defaultRoutingModel: string | null;
}

interface ModelPreferencesRow {
  enabled_models: string;
  default_model: string | null;
  default_plan_model: string | null;
  default_routing_model: string | null;
}

export class ModelPreferencesStore {
  constructor(private readonly db: D1Database) {}

  /**
   * Get the full singleton preferences row, or null if no preferences stored.
   */
  async getPreferences(): Promise<ModelPreferences | null> {
    const row = await this.db
      .prepare(
        "SELECT enabled_models, default_model, default_plan_model, default_routing_model FROM model_preferences WHERE id = 'global'"
      )
      .first<ModelPreferencesRow>();

    if (!row) return null;

    return {
      enabledModels: JSON.parse(row.enabled_models) as string[],
      defaultModel: row.default_model,
      defaultPlanModel: row.default_plan_model,
      defaultRoutingModel: row.default_routing_model,
    };
  }

  /**
   * Back-compat shim. Prefer getPreferences() for new callers.
   */
  async getEnabledModels(): Promise<string[] | null> {
    return (await this.getPreferences())?.enabledModels ?? null;
  }

  /**
   * Atomically persist the preference fields. defaultModel / defaultPlanModel /
   * defaultRoutingModel may be null (= delegate to env/shared fallback). When
   * non-null, they must be members of enabledModels.
   */
  async setPreferences(prefs: ModelPreferences): Promise<void> {
    const unique = [...new Set(prefs.enabledModels)];
    const invalid = unique.filter((id) => !isValidModel(id));
    if (invalid.length > 0) {
      throw new ModelPreferencesValidationError(`Invalid model IDs: ${invalid.join(", ")}`);
    }

    if (unique.length === 0) {
      throw new ModelPreferencesValidationError("At least one model must be enabled");
    }

    const enabledSet = new Set(unique);

    if (prefs.defaultModel !== null) {
      if (!isValidModel(prefs.defaultModel)) {
        throw new ModelPreferencesValidationError(
          `Invalid default model ID: ${prefs.defaultModel}`
        );
      }
      if (!enabledSet.has(prefs.defaultModel)) {
        throw new ModelPreferencesValidationError(
          `Default model "${prefs.defaultModel}" is not in the enabled models list`
        );
      }
    }

    if (prefs.defaultPlanModel !== null) {
      if (!isValidModel(prefs.defaultPlanModel)) {
        throw new ModelPreferencesValidationError(
          `Invalid default plan model ID: ${prefs.defaultPlanModel}`
        );
      }
      if (!enabledSet.has(prefs.defaultPlanModel)) {
        throw new ModelPreferencesValidationError(
          `Default plan model "${prefs.defaultPlanModel}" is not in the enabled models list`
        );
      }
    }

    if (prefs.defaultRoutingModel !== null) {
      if (!isValidModel(prefs.defaultRoutingModel)) {
        throw new ModelPreferencesValidationError(
          `Invalid default routing model ID: ${prefs.defaultRoutingModel}`
        );
      }
      if (!enabledSet.has(prefs.defaultRoutingModel)) {
        throw new ModelPreferencesValidationError(
          `Default routing model "${prefs.defaultRoutingModel}" is not in the enabled models list`
        );
      }
    }

    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO model_preferences (id, enabled_models, default_model, default_plan_model, default_routing_model, updated_at)
         VALUES ('global', ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           enabled_models        = excluded.enabled_models,
           default_model         = excluded.default_model,
           default_plan_model    = excluded.default_plan_model,
           default_routing_model = excluded.default_routing_model,
           updated_at            = excluded.updated_at`
      )
      .bind(
        JSON.stringify(unique),
        prefs.defaultModel,
        prefs.defaultPlanModel,
        prefs.defaultRoutingModel,
        now
      )
      .run();
  }
}
