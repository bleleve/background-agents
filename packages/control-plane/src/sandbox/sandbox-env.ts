import type { McpServerConfig } from "@open-inspect/shared";

/**
 * Shared assembly for the sandbox environment contract.
 *
 * The runtime decodes the `SESSION_CONFIG` env var into a single canonical
 * shape (see the Python `SessionConfig` in
 * `packages/sandbox-runtime/src/sandbox_runtime/types.py`). Every provider used
 * to hand-roll that object independently, which let fields silently diverge —
 * the Daytona provider dropped `mcp_servers` entirely because its local copy
 * never added the key. This module is the single source of truth for the shape
 * so providers serialize it instead of reassembling ad-hoc objects.
 *
 * The runtime reads `session_id`, `branch`, `provider`, `model`, and
 * `mcp_servers` from this payload; `repo_owner` / `repo_name` are included to
 * mirror the full contract.
 */

/** Canonical `SESSION_CONFIG` payload handed to the sandbox runtime. */
export interface SessionConfigPayload {
  session_id: string;
  repo_owner: string;
  repo_name: string;
  provider: string;
  model: string;
  /** Omitted from the serialized payload when undefined. */
  mcp_servers?: McpServerConfig[];
  /** Omitted from the serialized payload when undefined. */
  branch?: string;
  /**
   * Whether the agent may submit a formal GitHub PR review (APPROVE /
   * REQUEST_CHANGES). Tri-state: omitted ⇒ session is not governed (the sandbox
   * guard stays inert); `false` ⇒ block formal reviews; `true` ⇒ allow. Only
   * github-bot sessions set it. Omitted from the serialized payload when
   * undefined.
   */
  allow_formal_review?: boolean;
}

/** Provider-agnostic inputs needed to assemble a {@link SessionConfigPayload}. */
export interface SessionConfigInput {
  sessionId: string;
  repoOwner: string;
  repoName: string;
  provider: string;
  model: string;
  mcpServers?: McpServerConfig[];
  branch?: string;
  /** See {@link SessionConfigPayload.allow_formal_review}. Undefined ⇒ omitted. */
  allowFormalReview?: boolean;
}

/**
 * Build the canonical `SESSION_CONFIG` payload from provider inputs.
 *
 * `mcp_servers` is always set (left undefined when absent) so `JSON.stringify`
 * omits it — matching how the runtime treats an absent key and an empty list
 * identically. `branch` is only set when provided.
 */
export function buildSessionConfig(input: SessionConfigInput): SessionConfigPayload {
  const payload: SessionConfigPayload = {
    session_id: input.sessionId,
    repo_owner: input.repoOwner,
    repo_name: input.repoName,
    provider: input.provider,
    model: input.model,
    mcp_servers: input.mcpServers,
  };
  if (input.branch) {
    payload.branch = input.branch;
  }
  // Tri-state: only set the key when explicitly defined so an omitted value
  // reaches the runtime as "not governed" rather than "block".
  if (input.allowFormalReview !== undefined) {
    payload.allow_formal_review = input.allowFormalReview;
  }
  return payload;
}
