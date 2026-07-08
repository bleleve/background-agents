import {
  getValidModelOrDefault,
  isValidReasoningEffort,
  type CreateSessionInput,
} from "@open-inspect/shared";
import { encryptTokenPair, generateId } from "../auth/crypto";
import { DEFAULT_TOKEN_LIFETIME_MS, UserScmTokenStore } from "../db/user-scm-tokens";
import { UserStore } from "../db/user-store";
import { createLogger, type Logger } from "../logger";
import { classifyIntent } from "../routing/intent-classifier";
import { parseCreateSessionInput } from "../session/create-session-input";
import { initializeSession, type SessionInitInput } from "../session/initialize";
import {
  deriveParticipantUserId,
  resolveGitHubEnrichment,
  resolveProviderIdentity,
} from "../session/identity";
import {
  resolveCodeServerEnabled,
  resolveSandboxSettings,
} from "../session/integration-settings-resolution";
import type { CreateSessionResponse, Env } from "../types";
import {
  error,
  json,
  normalizeOptionalRepositoryContext,
  parsePattern,
  RepositoryContextValidationError,
  resolveRepoOrError,
  type OptionalRepositoryContext,
  type RequestContext,
  type Route,
} from "./shared";

const logger = createLogger("router:session-create");
const INVALID_SESSION_REQUEST_BODY_ERROR = "Invalid session request body";

/**
 * Surfaces the intent classifier covers for plan-vs-direct inference at
 * session-create time. github-bot and slack-bot resolve plan mode themselves
 * (via their own `/internal/route-intent` calls) before ever calling this
 * endpoint, so they always send an explicit `planMode`; `agent`/`automation`
 * sessions aren't a free-text human request in the same sense, so there's
 * nothing to classify. Everything else falls through to the `false` default.
 */
export function classificationSurfaceFor(
  spawnSource: CreateSessionInput["spawnSource"]
): "linear" | "web" | null {
  if (spawnSource === "linear-bot") return "linear";
  if (spawnSource === "user") return "web";
  return null;
}

/**
 * Resolve `planMode` for a session-create request. An explicit `body.planMode`
 * always wins — inference only runs when it's omitted. When it runs, a
 * classifier failure of any kind (see `IntentRouterFallbackReason`) falls
 * back to `false`, identical to today's behavior for an unset `planMode` —
 * this must never be a new way for session creation to fail or behave
 * unpredictably. `INTENT_ROUTER_MODE_SESSION_CREATE` gates whether the
 * inferred mode is actually acted on (`"classifier"`) or only classified for
 * telemetry while still defaulting to `false` (`"shadow"`, the default).
 */
export async function resolvePlanMode(
  env: Env,
  log: Logger,
  body: CreateSessionInput,
  ctx: RequestContext
): Promise<boolean> {
  if (body.planMode !== undefined) return body.planMode;

  const surface = classificationSurfaceFor(body.spawnSource);
  if (!surface || !body.planClassificationText) return false;

  const result = await classifyIntent(
    env,
    log,
    { surface, text: body.planClassificationText, title: body.title },
    { trace_id: ctx.trace_id, request_id: ctx.request_id }
  );
  if (result.source !== "classifier") return false;

  const inferredPlanMode = result.mode === "plan";
  const acting = env.INTENT_ROUTER_MODE_SESSION_CREATE === "classifier";
  if (!acting) {
    // Shadow: log the divergence between what the classifier would have
    // decided and what actually happens (always "direct" here — there is no
    // other deterministic signal once planMode is unset), without acting on
    // it. This is the calibration data future promotion decisions read.
    log.info("intent_router.shadow", {
      trace_id: ctx.trace_id,
      surface,
      inferred_mode: result.mode,
      acted_mode: "direct",
      confidence: result.confidence,
      diverged: inferredPlanMode,
    });
    return false;
  }
  return inferredPlanMode;
}

async function handleCreateSession(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const parsed = await parseCreateSessionInput(request);
  if (!parsed.ok) return error(parsed.message, 400);
  const body = parsed.input;

  let repositoryContext: OptionalRepositoryContext;
  try {
    repositoryContext = normalizeOptionalRepositoryContext(
      body,
      INVALID_SESSION_REQUEST_BODY_ERROR
    );
  } catch (e) {
    if (e instanceof RepositoryContextValidationError) {
      return error(e.message, 400);
    }
    throw e;
  }

  // Validate branch name if provided (defense in depth)
  if (body.branch && !/^[\w.\-/]+$/.test(body.branch)) {
    return error("Invalid branch name");
  }

  let repoId: number | null = null;
  let defaultBranch: string | null = null;
  let repoOwner: string | null = null;
  let repoName: string | null = null;
  if (repositoryContext) {
    repoOwner = repositoryContext.repoOwner;
    repoName = repositoryContext.repoName;
    const resolved = await resolveRepoOrError(env, repoOwner, repoName, ctx, logger);
    if (resolved instanceof Response) return resolved;

    repoId = resolved.repoId;
    defaultBranch = resolved.defaultBranch;
  }

  const participantUserId = deriveParticipantUserId(body);

  // Resolve canonical user model ID (for D1 session index).
  // Best-effort: if resolution fails, the session is created without a user_id.
  const userStore = new UserStore(env.DB);
  let resolvedUserId: string | null = null;
  const providerIdentity = resolveProviderIdentity(body.spawnSource ?? "user", body);
  if (providerIdentity) {
    try {
      const resolvedUser = await userStore.resolveOrCreateUser(providerIdentity);
      resolvedUserId = resolvedUser.id;
    } catch (e) {
      logger.warn("Failed to resolve user identity, session will have no user_id", {
        error: e instanceof Error ? e : String(e),
        provider: providerIdentity.provider,
      });
    }
  }

  let scmLogin = body.scmLogin;
  let scmName = body.scmName;
  let scmEmail = body.scmEmail;
  const scmToken = body.scmToken;
  const scmRefreshToken = body.scmRefreshToken;
  let scmTokenExpiresAt = body.scmTokenExpiresAt;
  let scmUserId = body.scmUserId;
  let scmTokenEncrypted: string | null = null;
  let scmRefreshTokenEncrypted: string | null = null;

  if (env.TOKEN_ENCRYPTION_KEY) {
    try {
      ({
        accessTokenEncrypted: scmTokenEncrypted,
        refreshTokenEncrypted: scmRefreshTokenEncrypted,
      } = await encryptTokenPair(scmToken, scmRefreshToken, env.TOKEN_ENCRYPTION_KEY));
    } catch (e) {
      logger.error("Failed to encrypt SCM token", {
        error: e instanceof Error ? e.message : String(e),
      });
      return error("Failed to process SCM token", 500);
    }
  }

  // Enrich the owner with their linked GitHub identity from D1: fill in SCM
  // fields the caller didn't provide (email, display name, OAuth token).
  //
  // This intentionally applies even when the session was authenticated via a
  // non-GitHub provider (e.g. Google): if the canonical user has ALSO linked a
  // verified-email GitHub identity, enrichment surfaces THAT identity's token so
  // the same human keeps GitHub-attributed commits/PRs. resolveGitHubEnrichment
  // keys off the linked `provider === "github"` identity, never the Google
  // credential; a user with no linked GitHub identity gets null here and falls
  // back to the App bot. The invariant is "a Google credential is never used as
  // an SCM credential", not "a Google-authenticated session carries no SCM state".
  if (resolvedUserId) {
    try {
      const enrichment = await resolveGitHubEnrichment(env, userStore, resolvedUserId);
      if (enrichment) {
        scmUserId ??= enrichment.scmUserId;
        scmLogin ??= enrichment.scmLogin;
        scmName ??= enrichment.displayName;
        scmEmail ??= enrichment.email;
        if (!scmTokenEncrypted) {
          scmTokenEncrypted = enrichment.accessTokenEncrypted ?? null;
          scmRefreshTokenEncrypted = enrichment.refreshTokenEncrypted ?? null;
          scmTokenExpiresAt = enrichment.tokenExpiresAt;
        }
      }
    } catch (e) {
      logger.warn("Failed to enrich session with GitHub identity", {
        error: e instanceof Error ? e : String(e),
      });
    }
  }

  // Validate model and reasoning effort once for both DO init and D1 index
  const model = getValidModelOrDefault(body.model);
  const reasoningEffort =
    body.reasoningEffort && isValidReasoningEffort(model, body.reasoningEffort)
      ? body.reasoningEffort
      : null;

  // Resolve code-server integration setting and sandbox settings for this repo
  const [codeServerEnabled, sandboxSettings] = await Promise.all([
    resolveCodeServerEnabled(env.DB, repoOwner, repoName),
    resolveSandboxSettings(env.DB, repoOwner, repoName),
  ]);

  const sessionId = generateId();

  // Resolve before building `input`: an explicit body.planMode always wins;
  // an omitted one is inferred via the intent classifier for the surfaces it
  // covers (see resolvePlanMode), falling back to false (today's behavior)
  // otherwise. Never affects planModel — model selection stays label/config
  // driven; a classifier-inferred plan uses the DO's DEFAULT_PLAN_MODEL
  // fallback, same as an unset planModel does today.
  const resolvedPlanMode = await resolvePlanMode(env, logger, body, ctx);

  const input: SessionInitInput = {
    sessionId,
    repoOwner,
    repoName,
    repoId,
    defaultBranch,
    branch: body.branch,
    title: body.title,
    model,
    reasoningEffort,
    participantUserId,
    platformUserId: resolvedUserId,
    scmLogin,
    scmName,
    scmEmail,
    scmUserId,
    scmTokenEncrypted,
    scmRefreshTokenEncrypted,
    scmTokenExpiresAt,
    codeServerEnabled,
    sandboxSettings,
    spawnSource: body.spawnSource,
    // PR descriptor for sessions that act on an existing PR (github-bot
    // review/comment sessions). Threaded to the DO so it seeds a `pr` artifact
    // at init — that artifact is what surfaces the "View PR" link in the web UI.
    prNumber: body.prNumber,
    prUrl: body.prUrl,
    prState: body.prState,
    prHeadRef: body.prHeadRef,
    prBaseRef: body.prBaseRef,
    previewEnabled: body.previewEnabled,
    // Plan mode: gate the session on human plan approval before any
    // code-changing turn. Without this the home-page "Plan" toggle is silently
    // dropped and the first turn dispatches as a normal build (regression from
    // the router-module refactor #692, which lost these two lines). See
    // resolvePlanMode above for how an omitted planMode is now inferred.
    planMode: resolvedPlanMode,
    planModel: body.planMode === true ? body.planModel : undefined,
    // Marks a dedicated PR review session so the sandbox gh guard blocks raw
    // issue comments (verdict-only). Set only by the github-bot review path.
    reviewSession: body.reviewSession === true,
  };

  try {
    await initializeSession(env, input, ctx);
  } catch (e) {
    logger.error("Failed to initialize session", {
      error: e instanceof Error ? e.message : String(e),
      session_id: sessionId,
      trace_id: ctx.trace_id,
    });
    return error("Failed to create session", 500);
  }

  // Populate D1 with the user's SCM tokens (non-blocking) so centralized refresh works
  if (scmUserId && scmToken && scmRefreshToken && env.TOKEN_ENCRYPTION_KEY) {
    ctx.executionCtx?.waitUntil(
      new UserScmTokenStore(env.DB, env.TOKEN_ENCRYPTION_KEY)
        .upsertTokens(
          scmUserId,
          scmToken,
          scmRefreshToken,
          scmTokenExpiresAt ?? Date.now() + DEFAULT_TOKEN_LIFETIME_MS,
          resolvedUserId
        )
        .catch((e) =>
          logger.error("Failed to write tokens to D1", {
            error: e instanceof Error ? e : String(e),
          })
        )
    );
  }

  const result: CreateSessionResponse = {
    sessionId,
    status: "created",
  };

  return json(result, 201);
}

export const sessionCreateRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/sessions"),
    handler: handleCreateSession,
  },
];
