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

/** Sandbox environment settings. Provider-agnostic: describes what the user wants, not how it's done. */
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
