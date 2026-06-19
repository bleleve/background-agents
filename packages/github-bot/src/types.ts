/**
 * Environment bindings for the GitHub Bot Cloudflare Worker.
 */
export interface Env {
  /** KV namespace for deduplicating webhook deliveries. */
  GITHUB_KV: KVNamespace;

  /** Service binding to the control plane worker. */
  CONTROL_PLANE: Fetcher;

  /** Deployment name for logging/identification. */
  DEPLOYMENT_NAME: string;

  /** Display name shown in user-visible bot messages and HTTP User-Agent headers. */
  APP_NAME?: string;

  /** Web app base URL (e.g. https://reef.example.com), used to link sessions from PR comments. */
  WEB_APP_URL: string;

  /** Default model ID for new sessions. */
  DEFAULT_MODEL: string;

  /**
   * Default model used during planning turns (plan-mode sessions). When unset,
   * the shared DEFAULT_PLAN_MODEL constant from @open-inspect/shared is used.
   */
  DEFAULT_PLAN_MODEL?: string;

  /** GitHub App bot username (e.g., "open-inspect-bot[bot]"). */
  GITHUB_BOT_USERNAME: string;

  /** GitHub App ID for JWT generation. */
  GITHUB_APP_ID: string;

  /** GitHub App private key (PKCS#8 PEM) for JWT signing. */
  GITHUB_APP_PRIVATE_KEY: string;

  /** GitHub App installation ID for token exchange. */
  GITHUB_APP_INSTALLATION_ID: string;

  /** Webhook secret for verifying GitHub webhook signatures. */
  GITHUB_WEBHOOK_SECRET: string;

  /** Shared secret for HMAC auth to the control plane. */
  INTERNAL_CALLBACK_SECRET: string;

  /** Optional log level override. */
  LOG_LEVEL?: string;

  /**
   * When set to "true", the bot also responds to the @reef mention alias.
   * Only enable this in the production environment.
   */
  REEF_ALIAS_ENABLED?: string;
}

/**
 * Webhook payload types — narrow types extracted from the GitHub webhook
 * event schema containing only the fields the bot reads.
 */

export interface PullRequestOpenedPayload {
  action: "opened" | "ready_for_review";
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state: string;
    user: { login: string };
    head: { ref: string; sha: string; repo?: { full_name: string } };
    base: { ref: string };
    draft: boolean;
    labels?: Array<{ name: string }>;
  };
  repository: { owner: { login: string }; name: string; private: boolean };
  sender: { login: string; id: number; avatar_url: string };
}

export interface PullRequestLabeledPayload {
  action: "labeled";
  label: { name: string };
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state: string;
    user: { login: string };
    head: { ref: string; sha: string; repo?: { full_name: string } };
    base: { ref: string };
    draft: boolean;
    labels?: Array<{ name: string }>;
  };
  repository: { owner: { login: string }; name: string; private: boolean };
  sender: { login: string; id: number; avatar_url: string };
}

export interface PullRequestSynchronizedPayload {
  action: "synchronize";
  pull_request: PullRequestLabeledPayload["pull_request"];
  repository: PullRequestLabeledPayload["repository"];
  sender: PullRequestLabeledPayload["sender"];
}

export interface ReviewRequestedPayload {
  action: "review_requested";
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state: string;
    user: { login: string };
    head: { ref: string; sha: string; repo?: { full_name: string } };
    base: { ref: string };
    labels?: Array<{ name: string }>;
  };
  requested_reviewer?: { login: string };
  repository: { owner: { login: string }; name: string; private: boolean };
  sender: { login: string; id: number; avatar_url: string };
}

export interface IssueCommentPayload {
  action: "created";
  issue: {
    number: number;
    title: string;
    html_url: string;
    state: string;
    pull_request?: { url: string };
    labels?: Array<{ name: string }>;
  };
  comment: {
    id: number;
    body: string;
    user: { login: string };
  };
  repository: { owner: { login: string }; name: string; private: boolean };
  sender: { login: string; id: number; avatar_url: string };
}

export interface ReviewCommentPayload {
  action: "created";
  pull_request: {
    number: number;
    title: string;
    html_url: string;
    state: string;
    head: { ref: string; sha: string; repo?: { full_name: string } };
    base: { ref: string };
    labels?: Array<{ name: string }>;
  };
  comment: {
    id: number;
    body: string;
    path: string;
    diff_hunk: string;
    position: number | null;
    line?: number | null;
    user: { login: string };
  };
  repository: { owner: { login: string }; name: string; private: boolean };
  sender: { login: string; id: number; avatar_url: string };
}

export interface ReviewThreadPayload {
  action: "resolved" | "unresolved";
  thread: {
    comments: Array<{ id: number }>;
  };
  pull_request: { number: number };
  repository: { owner: { login: string }; name: string; private: boolean };
  sender: { login: string; id: number };
}

export interface CheckSuiteCompletedPayload {
  action: "completed";
  check_suite: {
    conclusion: string | null;
    pull_requests: Array<{ number: number }>;
  };
  repository: { owner: { login: string }; name: string; private: boolean };
  sender: { login: string };
}

export interface PullRequestReviewPayload {
  action: "submitted" | "edited" | "dismissed";
  review: {
    id: number;
    // Lowercase in the webhook ("approved" | "changes_requested" | "commented" |
    // "dismissed" | "pending") — note the REST list-reviews API returns uppercase.
    state: string;
    body: string | null;
    user: { login: string };
  };
  pull_request: { number: number; state: string };
  repository: { owner: { login: string }; name: string; private: boolean };
  sender: { login: string; id: number };
}

export interface PullRequestStateChangedPayload {
  action: "closed" | "reopened";
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state: string;
    merged?: boolean;
    draft?: boolean;
    user: { login: string };
    head: { ref: string; sha: string; repo?: { full_name: string } };
    base: { ref: string };
    labels?: Array<{ name: string }>;
  };
  repository: { owner: { login: string }; name: string; private: boolean };
  sender?: { login: string; id: number; avatar_url: string };
}
