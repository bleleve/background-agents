// Integration settings types

export type IntegrationId = "github" | "linear" | "code-server" | "sandbox" | "slack";

/** Enforces the common shape for all integration configurations. */
export interface IntegrationEntry<
  TRepo extends object = Record<string, unknown>,
  TGlobalDefaults extends object = TRepo,
> {
  global: {
    enabledRepos?: string[];
    defaults?: TGlobalDefaults;
  };
  repo: TRepo;
}

/** Overridable behavior settings for the GitHub bot. Used at both global (defaults) and per-repo (overrides) levels. */
export interface GitHubBotSettings {
  autoReviewOnOpen?: boolean;
  autoApproveOnOpen?: boolean;
  privateReposOnly?: boolean;
  model?: string;
  reasoningEffort?: string;
  allowedTriggerUsers?: string[];
  codeReviewInstructions?: string;
  commentActionInstructions?: string;
}

/** Overridable behavior settings for the Linear bot. Used at both global (defaults) and per-repo (overrides) levels. */
export interface LinearBotSettings {
  model?: string;
  reasoningEffort?: string;
  allowUserPreferenceOverride?: boolean;
  allowLabelModelOverride?: boolean;
  emitToolProgressActivities?: boolean;
  issueSessionInstructions?: string;
}

/** Overridable behavior settings for the code-server integration. */
export interface CodeServerSettings {
  enabled?: boolean;
}

/** Maximum number of tunnel ports a user can configure per sandbox. */
export const MAX_TUNNEL_PORTS = 10;

/** Maximum number of AWS roles a user can configure per sandbox scope. */
export const MAX_AWS_ROLES = 10;

/**
 * A named AWS IAM role to assume via Modal OIDC federation.
 * The role ARN is assumed on each sandbox launch and its short-lived credentials
 * are injected as AWS_<PROFILE>_* environment variables (and as the default
 * profile when profileName is "default").
 */
export interface AwsRoleConfig {
  /** Human-readable profile name written to ~/.aws/credentials (e.g. "default", "prod", "staging"). */
  profileName: string;
  /** Full IAM role ARN to assume (e.g. "arn:aws:iam::123456789012:role/my-role"). */
  roleArn: string;
}

/** Default maximum active agent-spawned child sessions per parent session. */
export const DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS = 5;

/** Default maximum agent-spawned child sessions per parent session. */
export const DEFAULT_MAX_TOTAL_CHILD_SESSIONS = 15;

/**
 * Sandbox environment settings. Provider-agnostic: describes what the user
 * wants, not how it's done. Resource fields (`cpuCores`, `memoryMib`) are
 * advisory and provider-dependent — Modal maps them directly, Vercel maps
 * them to vCPUs, and providers without resource reservations ignore them. We
 * only check they're positive; the provider enforces its own real limits. When
 * unset, the provider's own default applies. At repo scope, `null` explicitly
 * uses the provider default instead of inheriting a global resource default.
 */
export interface SandboxSettings {
  /** Extra ports to expose via tunnels (e.g., dev server ports 3000, 5173). */
  tunnelPorts?: number[];
  /** Enable a browser-based terminal (ttyd) in sandbox sessions. */
  terminalEnabled?: boolean;
  /**
   * AWS IAM roles to assume via Modal OIDC on each sandbox launch.
   * Credentials are injected into the sandbox via ~/.aws/credentials.
   */
  awsRoles?: AwsRoleConfig[];
  /** Maximum active agent-spawned child sessions per parent session. */
  maxConcurrentChildSessions?: number;
  /** Maximum total agent-spawned child sessions per parent session. */
  maxTotalChildSessions?: number;
  /**
   * CPU cores to reserve for the sandbox. Fractional values are allowed, but
   * providers may round to their supported resource shapes. Unset →
   * inherit/default; null → provider default.
   */
  cpuCores?: number | null;
  /**
   * Memory to reserve for the sandbox, in MiB. Providers may map this to their
   * closest supported resource shape. Unset → inherit/default; null → provider
   * default.
   */
  memoryMib?: number | null;
  /**
   * Whether the coding agent in this session may submit a formal GitHub PR
   * review (event APPROVE or REQUEST_CHANGES). Only github-bot sessions set
   * this: review sessions inherit it from `autoApproveOnOpen`; comment-action
   * and failed-checks sessions set it `false`. Absent ⇒ session is not governed
   * (no enforcement) — inline comments and the verdict comment are always
   * allowed regardless. The sandbox guard reads this (threaded via
   * `SESSION_CONFIG.allow_formal_review`) to block off-policy formal reviews.
   */
  allowFormalReview?: boolean;
}

export type SlackMentionsPolicy = "allow" | "escape" | "strip";

/** Per-repo Slack overrides. Mentions policy is workspace-wide and cannot be overridden per repo. */
export interface SlackRepoSettings {
  agentNotificationsEnabled?: boolean;
}

/** Global Slack defaults: per-repo fields plus workspace-wide policy controls. */
export interface SlackGlobalSettings extends SlackRepoSettings {
  mentionsPolicy?: SlackMentionsPolicy;
}

/** Maps each integration ID to its global and per-repo settings types. */
export interface IntegrationSettingsMap {
  github: IntegrationEntry<GitHubBotSettings>;
  linear: IntegrationEntry<LinearBotSettings>;
  "code-server": IntegrationEntry<CodeServerSettings>;
  sandbox: IntegrationEntry<SandboxSettings>;
  slack: IntegrationEntry<SlackRepoSettings, SlackGlobalSettings>;
}

/** Derived type for the GitHub bot global config. */
export type GitHubGlobalConfig = IntegrationSettingsMap["github"]["global"];
export type LinearGlobalConfig = IntegrationSettingsMap["linear"]["global"];
export type CodeServerGlobalConfig = IntegrationSettingsMap["code-server"]["global"];
export type SandboxGlobalConfig = IntegrationSettingsMap["sandbox"]["global"];
export type SlackGlobalConfig = IntegrationSettingsMap["slack"]["global"];

/** Full MCP server config with decrypted credentials. Internal use only. */
export interface McpServerConfig {
  id: string;
  name: string;
  type: "local" | "remote";
  command?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  repoScopes?: string[] | null;
  enabled: boolean;
}

/** MCP server metadata for API responses — no decrypted credentials. */
export interface McpServerMetadata {
  id: string;
  name: string;
  type: "local" | "remote";
  command?: string[];
  url?: string;
  hasEnv: boolean;
  hasHeaders: boolean;
  repoScopes?: string[] | null;
  enabled: boolean;
}

export const INTEGRATION_DEFINITIONS: {
  id: IntegrationId;
  name: string;
  description: string;
}[] = [
  {
    id: "github",
    name: "GitHub Bot",
    description: "Automated PR reviews and comment-triggered actions",
  },
  {
    id: "linear",
    name: "Linear Agent",
    description: "Issue-driven coding sessions from Linear agent mentions",
  },
  {
    id: "code-server",
    name: "Code Server",
    description: "Browser-based VS Code editor attached to sandbox sessions",
  },
  {
    id: "sandbox",
    name: "Sandbox",
    description: "Sandbox environment settings (tunnel ports, timeouts, etc.)",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Agent-driven Slack notifications and mention policy",
  },
];
