import type { PreambleMatcher, PreambleRule, PreambleSource } from "@open-inspect/shared";
import { createLogger } from "../logger";

const log = createLogger("db:preamble-rules");

export class PreambleRuleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreambleRuleValidationError";
  }
}

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

interface PreambleRuleRow {
  id: string;
  source: string;
  matcher_json: string;
  preamble: string;
  priority: number;
  enabled: number;
  suggests_session_type: string | null;
  created_at: number;
  updated_at: number;
}

const VALID_SOURCES: ReadonlySet<PreambleSource> = new Set([
  "slack",
  "github",
  "linear",
  "default",
]);
const VALID_MATCHER_TYPES: ReadonlySet<PreambleMatcher["type"]> = new Set([
  "channel_name_regex",
  "channel_description_contains",
  "repo_full_name",
  "linear_team_key",
  "always",
]);

/**
 * Reject matchers whose shape doesn't conform to the discriminated union in
 * `@open-inspect/shared`. Operator-authored JSON in D1 can drift from code, so
 * we validate at write time and again at read time (defensive — a bad row
 * shouldn't crash the resolver for unrelated rules).
 */
export function validateMatcher(value: unknown): PreambleMatcher {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PreambleRuleValidationError("matcher must be a JSON object");
  }
  const obj = value as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== "string" || !VALID_MATCHER_TYPES.has(type as PreambleMatcher["type"])) {
    throw new PreambleRuleValidationError(
      `matcher.type must be one of: ${[...VALID_MATCHER_TYPES].join(", ")}`
    );
  }
  switch (type) {
    case "always":
      return { type: "always" };
    case "channel_name_regex": {
      if (typeof obj.pattern !== "string" || !obj.pattern) {
        throw new PreambleRuleValidationError("matcher.pattern must be a non-empty string");
      }
      try {
        new RegExp(obj.pattern);
      } catch {
        throw new PreambleRuleValidationError(
          `matcher.pattern is not a valid regex: ${obj.pattern}`
        );
      }
      return { type: "channel_name_regex", pattern: obj.pattern };
    }
    case "channel_description_contains": {
      if (
        !Array.isArray(obj.keywords) ||
        obj.keywords.length === 0 ||
        !obj.keywords.every((k) => typeof k === "string" && k.length > 0)
      ) {
        throw new PreambleRuleValidationError(
          "matcher.keywords must be a non-empty array of non-empty strings"
        );
      }
      return { type: "channel_description_contains", keywords: obj.keywords as string[] };
    }
    case "repo_full_name": {
      if (typeof obj.value !== "string" || !obj.value.includes("/")) {
        throw new PreambleRuleValidationError("matcher.value must be 'owner/repo'");
      }
      return { type: "repo_full_name", value: obj.value };
    }
    case "linear_team_key": {
      if (typeof obj.value !== "string" || !obj.value) {
        throw new PreambleRuleValidationError("matcher.value must be a non-empty string");
      }
      return { type: "linear_team_key", value: obj.value };
    }
  }
  throw new PreambleRuleValidationError(`unsupported matcher.type: ${type}`);
}

function rowToRule(row: PreambleRuleRow): PreambleRule | null {
  let matcher: PreambleMatcher;
  try {
    matcher = validateMatcher(JSON.parse(row.matcher_json));
  } catch (err) {
    log.warn("preamble rule has invalid matcher_json — skipping", {
      event: "preamble_rule.invalid_matcher",
      id: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  return {
    id: row.id,
    source: row.source as PreambleSource,
    matcher,
    preamble: row.preamble,
    priority: row.priority,
    enabled: row.enabled === 1,
    suggestsSessionType: row.suggests_session_type === "telemetry" ? "telemetry" : undefined,
  };
}

export interface CreatePreambleRuleInput {
  source: PreambleSource;
  matcher: PreambleMatcher;
  preamble: string;
  priority?: number;
  enabled?: boolean;
  suggestsSessionType?: "telemetry";
}

export interface UpdatePreambleRuleInput {
  source?: PreambleSource;
  matcher?: PreambleMatcher;
  preamble?: string;
  priority?: number;
  enabled?: boolean;
  suggestsSessionType?: "telemetry" | null;
}

export class PreambleRuleStore {
  constructor(private readonly db: D1Database) {}

  async list(source?: PreambleSource): Promise<PreambleRule[]> {
    const sql = source
      ? "SELECT * FROM preamble_rules WHERE source = ? ORDER BY priority DESC, id ASC"
      : "SELECT * FROM preamble_rules ORDER BY priority DESC, id ASC";
    const stmt = source ? this.db.prepare(sql).bind(source) : this.db.prepare(sql);
    const { results } = await stmt.all<PreambleRuleRow>();
    return results.map(rowToRule).filter((r): r is PreambleRule => r !== null);
  }

  async get(id: string): Promise<PreambleRule | null> {
    const row = await this.db
      .prepare("SELECT * FROM preamble_rules WHERE id = ?")
      .bind(id)
      .first<PreambleRuleRow>();
    return row ? rowToRule(row) : null;
  }

  async create(input: CreatePreambleRuleInput): Promise<PreambleRule> {
    if (!VALID_SOURCES.has(input.source)) {
      throw new PreambleRuleValidationError(`invalid source: ${input.source}`);
    }
    if (!input.preamble || typeof input.preamble !== "string" || !input.preamble.trim()) {
      throw new PreambleRuleValidationError("preamble must be a non-empty string");
    }
    validateMatcher(input.matcher);

    const id = generateId();
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO preamble_rules
         (id, source, matcher_json, preamble, priority, enabled, suggests_session_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        input.source,
        JSON.stringify(input.matcher),
        input.preamble,
        input.priority ?? 0,
        input.enabled === false ? 0 : 1,
        input.suggestsSessionType ?? null,
        now,
        now
      )
      .run();

    const created = await this.get(id);
    if (!created) {
      throw new Error(`preamble rule '${id}' not found after insert — this should not happen`);
    }
    return created;
  }

  async update(id: string, patch: UpdatePreambleRuleInput): Promise<PreambleRule | null> {
    const row = await this.db
      .prepare("SELECT * FROM preamble_rules WHERE id = ?")
      .bind(id)
      .first<PreambleRuleRow>();
    if (!row) return null;

    if (patch.source !== undefined && !VALID_SOURCES.has(patch.source)) {
      throw new PreambleRuleValidationError(`invalid source: ${patch.source}`);
    }
    if (patch.preamble !== undefined) {
      if (typeof patch.preamble !== "string" || !patch.preamble.trim()) {
        throw new PreambleRuleValidationError("preamble must be a non-empty string");
      }
    }
    if (patch.matcher !== undefined) {
      validateMatcher(patch.matcher);
    }

    const matcherJson =
      patch.matcher !== undefined ? JSON.stringify(patch.matcher) : row.matcher_json;
    // `suggestsSessionType: null` explicitly clears the field. `undefined` (key
    // absent) leaves the existing value untouched.
    const suggests =
      patch.suggestsSessionType === undefined
        ? row.suggests_session_type
        : patch.suggestsSessionType;

    const now = Date.now();
    await this.db
      .prepare(
        `UPDATE preamble_rules
         SET source = ?, matcher_json = ?, preamble = ?, priority = ?, enabled = ?, suggests_session_type = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(
        patch.source ?? row.source,
        matcherJson,
        patch.preamble ?? row.preamble,
        patch.priority ?? row.priority,
        patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0,
        suggests,
        now,
        id
      )
      .run();

    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM preamble_rules WHERE id = ?").bind(id).run();
    return (result.meta?.changes ?? 0) > 0;
  }
}
