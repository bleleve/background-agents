/**
 * Contract constants for Session Durable Object internal endpoints.
 * Router and SessionDO must both import these to prevent path drift.
 */

export const SessionInternalPaths = {
  init: "/internal/init",
  state: "/internal/state",
  prompt: "/internal/prompt",
  stop: "/internal/stop",
  relaunchSandbox: "/internal/relaunch-sandbox",
  sandboxEvent: "/internal/sandbox-event",
  createMediaArtifact: "/internal/create-media-artifact",
  participants: "/internal/participants",
  events: "/internal/events",
  artifacts: "/internal/artifacts",
  messages: "/internal/messages",
  createPr: "/internal/create-pr",
  updatePrState: "/internal/update-pr-state",
  wsToken: "/internal/ws-token",
  archive: "/internal/archive",
  unarchive: "/internal/unarchive",
  verifySandboxToken: "/internal/verify-sandbox-token",
  openaiTokenRefresh: "/internal/openai-token-refresh",
  scmCredentials: "/internal/scm-credentials",
  bootProgress: "/internal/boot-progress",
  tunnelUrls: "/internal/tunnel-urls",
  spawnContext: "/internal/spawn-context",
  childSummary: "/internal/child-summary",
  updateTitle: "/internal/update-title",
  updatePreview: "/internal/update-preview",
  cancel: "/internal/cancel",
  childSessionUpdate: "/internal/child-session-update",
  plan: "/internal/plan",
  plans: "/internal/plans",
  planApprove: "/internal/plan/approve",
  planReject: "/internal/plan/reject",
  supersede: "/internal/supersede",
} as const;

export type SessionInternalPath = (typeof SessionInternalPaths)[keyof typeof SessionInternalPaths];

const INTERNAL_ORIGIN = "http://internal";

export function buildSessionInternalUrl(path: SessionInternalPath, search?: string): string {
  return `${INTERNAL_ORIGIN}${path}${search ?? ""}`;
}
