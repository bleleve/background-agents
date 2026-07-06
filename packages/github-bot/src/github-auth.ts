import { DEFAULT_APP_NAME } from "@open-inspect/shared";

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  installationId: string;
  /** User-Agent header sent on outbound GitHub API requests. */
  userAgent?: string;
}

function base64UrlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function parsePemPrivateKey(pem: string): Uint8Array {
  const pemContents = pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/g, "")
    .replace(/-----END RSA PRIVATE KEY-----/g, "")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");

  const binaryString = atob(pemContents);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const keyData = parsePemPrivateKey(pem);
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      keyData,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
  } catch {
    throw new Error(
      "Unable to import private key. Ensure it is in PKCS#8 format. " +
        "Convert with: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key-pkcs8.pem"
    );
  }
}

export async function generateAppJwt(appId: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 600, iss: appId };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await importPrivateKey(privateKey);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function getInstallationToken(
  jwt: string,
  installationId: string,
  userAgent: string
): Promise<string> {
  const url = `https://api.github.com/app/installations/${installationId}/access_tokens`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": userAgent,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get installation token: ${response.status} ${error}`);
  }

  const data = (await response.json()) as { token: string };
  return data.token;
}

export async function generateInstallationToken(config: GitHubAppConfig): Promise<string> {
  const jwt = await generateAppJwt(config.appId, config.privateKey);
  return getInstallationToken(jwt, config.installationId, config.userAgent || DEFAULT_APP_NAME);
}

const WRITE_PERMISSIONS = new Set(["write", "maintain", "admin"]);

export interface PermissionCheckResult {
  hasPermission: boolean;
  error?: boolean;
}

export async function checkSenderPermission(
  token: string,
  owner: string,
  repo: string,
  username: string,
  userAgent: string = DEFAULT_APP_NAME
): Promise<PermissionCheckResult> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}/permission`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": userAgent,
        },
      }
    );
    if (!response.ok) return { hasPermission: false, error: true };
    const data = (await response.json()) as { permission: string };
    return { hasPermission: WRITE_PERMISSIONS.has(data.permission) };
  } catch {
    return { hasPermission: false, error: true };
  }
}

export async function postReaction(
  token: string,
  url: string,
  content: string,
  userAgent: string = DEFAULT_APP_NAME
): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": userAgent,
      },
      body: JSON.stringify({ content }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Remove a label from a PR. Best-effort: returns true on success, false on any
 * failure (including 404 when the label isn't present — a no-op we treat as
 * success-equivalent for the caller's purposes). Never throws.
 */
export async function removeIssueLabel(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  label: string,
  userAgent: string = DEFAULT_APP_NAME
): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": userAgent,
        },
      }
    );
    // 404 means the label wasn't on the PR — nothing to do, not an error.
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

/**
 * Dismiss a formal PR review (reactive backstop for off-policy bot reviews).
 * Only APPROVED / CHANGES_REQUESTED reviews are dismissable — GitHub returns 422
 * for COMMENTED/PENDING/DISMISSED, which we treat as a non-fatal no-op (callers
 * pre-filter on state, so this is just belt-and-suspenders). Best-effort:
 * returns true on success, false on any failure. Never throws.
 */
export async function dismissPullRequestReview(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  reviewId: number,
  message: string,
  userAgent: string = DEFAULT_APP_NAME
): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/reviews/${reviewId}/dismissals`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": userAgent,
        },
        body: JSON.stringify({ message, event: "DISMISS" }),
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Submit a formal APPROVE review on a PR as the GitHub App. This is the bot's
 * label-driven auto-approval path (`visual-qa: pass` + `reef: low risk`) — the
 * agent never approves. Best-effort: returns true on success, false on any
 * failure. Never throws.
 */
export async function approvePullRequest(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  body: string,
  userAgent: string = DEFAULT_APP_NAME
): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/reviews`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": userAgent,
        },
        body: JSON.stringify({ event: "APPROVE", body }),
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}

// Page size and page cap for the verdict-comment lookup. 100 is GitHub's max
// per_page; 10 pages (1000 comments) is far more than any real PR thread, and
// the loop short-circuits the moment it finds the marker.
const ISSUE_COMMENTS_PER_PAGE = 100;
const ISSUE_COMMENTS_MAX_PAGES = 10;

/**
 * Find the id of the first issue comment whose body starts with `marker`.
 * Used to detect an already-posted verdict (the agent's own) before the bot
 * posts a fallback, and as the idempotency guard against duplicate callbacks.
 * Returns null when no such comment exists (or on error — caller treats a
 * lookup failure as "absent", which at worst posts a duplicate the marker
 * dedupes on the next pass).
 */
export async function findIssueCommentByMarker(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  marker: string,
  userAgent: string = DEFAULT_APP_NAME
): Promise<number | null> {
  for (let page = 1; page <= ISSUE_COMMENTS_MAX_PAGES; page++) {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments?per_page=${ISSUE_COMMENTS_PER_PAGE}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": userAgent,
        },
      }
    );
    if (!response.ok) return null;
    const comments = (await response.json()) as Array<{ id: number; body?: string }>;
    const match = comments.find((c) => (c.body ?? "").startsWith(marker));
    if (match) return match.id;
    if (comments.length < ISSUE_COMMENTS_PER_PAGE) break;
  }
  return null;
}

/**
 * Create an issue comment on a PR. Returns the new comment's id, or null on
 * failure (best-effort — the caller logs but does not throw).
 */
export async function createIssueComment(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
  userAgent: string = DEFAULT_APP_NAME
): Promise<number | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": userAgent,
        },
        body: JSON.stringify({ body }),
      }
    );
    if (!response.ok) return null;
    const created = (await response.json()) as { id: number };
    return created.id;
  } catch {
    return null;
  }
}

/**
 * Reply inside an existing PR review-comment thread, anchored to `commentId`
 * (any comment in the thread). Returns the reply's id, or null on failure
 * (best-effort — the caller logs but does not throw). Mirrors createIssueComment,
 * but hits the review-thread replies endpoint so the reply lands on the finding
 * rather than at the PR root.
 */
export async function createReviewCommentReply(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  commentId: number,
  body: string,
  userAgent: string = DEFAULT_APP_NAME
): Promise<number | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/comments/${commentId}/replies`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": userAgent,
        },
        body: JSON.stringify({ body }),
      }
    );
    if (!response.ok) return null;
    const created = (await response.json()) as { id: number };
    return created.id;
  } catch {
    return null;
  }
}
