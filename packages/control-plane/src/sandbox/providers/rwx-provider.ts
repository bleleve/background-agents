/**
 * RWX sandbox provider — triggers a dispatch on the RWX cloud platform.
 *
 * Each sandbox creation POSTs to the RWX Dispatch API with all sandbox
 * environment variables serialised as dispatch params. The user's RWX workflow
 * must define a dispatch trigger with a matching key and map the params to env
 * vars (see https://www.rwx.com/docs/dispatch-triggers).
 *
 * Capabilities: RWX dispatches are ephemeral CI runs. There is no filesystem
 * snapshot API, no persistent resume, and no explicit stop endpoint exposed by
 * the Dispatch API.
 */

import { computeHmacHex } from "@open-inspect/shared";
import { createLogger } from "../../logger";
import type { SourceControlProviderName } from "../../source-control";
import { buildSessionConfig } from "../sandbox-env";
import { RwxApiError, type RwxGetDispatchResponse, type RwxRestClient } from "../rwx-rest-client";
import {
  SandboxProviderError,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type SandboxProvider,
  type SandboxProviderCapabilities,
} from "../provider";

const log = createLogger("rwx-provider");

// ---------------------------------------------------------------------------
// Dispatch polling
// ---------------------------------------------------------------------------

const POLL_DISPATCH_INTERVAL_MS = 3_000;
const POLL_DISPATCH_MAX_ATTEMPTS = 20; // up to ~60 s; connecting-timeout covers the rest

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

export interface RwxProviderConfig {
  scmProvider: SourceControlProviderName;
  /** Secret used for HMAC derivation of code-server passwords */
  codeServerPasswordSecret: string;
  /**
   * RWX organization slug. When set, the provider constructs the app endpoint
   * URL as https://{session_id}--{orgSlug}.r1.rwx.run/ and returns it in
   * CreateSandboxResult as tunnelUrls (port 8080) so the UI shows a Preview
   * link. When codeServerEnabled is also true, the same URL is also set as
   * codeServerUrl.
   */
  orgSlug?: string;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class RwxSandboxProvider implements SandboxProvider {
  readonly name = "rwx";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: false,
    supportsRestore: false,
    supportsWarm: false,
    supportsPersistentResume: false,
    supportsExplicitStop: false,
  };

  constructor(
    private readonly client: RwxRestClient,
    private readonly providerConfig: RwxProviderConfig
  ) {}

  // -----------------------------------------------------------------------
  // SandboxProvider interface
  // -----------------------------------------------------------------------

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      const params = await this.buildDispatchParams(config);

      const dispatch = await this.client.createDispatch({
        key: `${config.repoOwner}-${config.repoName}`,
        params,
        ref: config.branch,
        title: `Open-Inspect session ${config.sessionId}`,
      });

      log.info("rwx.sandbox_dispatched", {
        session_id: config.sessionId,
        sandbox_id: config.sandboxId,
        dispatch_id: dispatch.dispatch_id,
      });

      const dispatchStatus = await this.waitForDispatch(dispatch.dispatch_id, config.sessionId);
      if (dispatchStatus.status === "error") {
        throw new SandboxProviderError(
          `RWX dispatch failed: ${dispatchStatus.error ?? "unknown error"}`,
          "permanent"
        );
      }

      // Use the run URL as providerObjectId when available — it is also the
      // dashboard link broadcast to the UI. Fall back to dispatch_id when
      // the dispatch hasn't produced a run yet (budget exhausted before ready).
      const runUrl = dispatchStatus.runs[0]?.run_url;
      const result: CreateSandboxResult = {
        sandboxId: config.sandboxId,
        providerObjectId: runUrl ?? dispatch.dispatch_id,
        status: "warming",
        createdAt: Date.now(),
      };

      if (this.providerConfig.orgSlug) {
        const appEndpointUrl = this.buildAppEndpointUrl(config.sessionId);
        result.tunnelUrls = { "8080": appEndpointUrl };

        if (config.codeServerEnabled) {
          result.codeServerUrl = appEndpointUrl;
          result.codeServerPassword = await this.deriveCodeServerPassword(config.sandboxId);
        }
      }

      return result;
    } catch (error) {
      throw this.classifyError("Failed to create RWX sandbox dispatch", error);
    }
  }

  // -----------------------------------------------------------------------
  // Dispatch polling
  // -----------------------------------------------------------------------

  /**
   * Poll getDispatch until the dispatch reaches a terminal state ("dispatched"
   * or "error"), or until the attempt budget is exhausted.
   *
   * The connecting-timeout watchdog covers the remaining window if the dispatch
   * hasn't settled by the time the budget runs out, so it's safe to return the
   * last known state and let createSandbox proceed.
   */
  private async waitForDispatch(
    dispatchId: string,
    sessionId: string
  ): Promise<RwxGetDispatchResponse> {
    let lastResponse: RwxGetDispatchResponse = { status: "pending", runs: [] };

    for (let i = 0; i < POLL_DISPATCH_MAX_ATTEMPTS; i++) {
      if (i > 0) {
        await sleep(POLL_DISPATCH_INTERVAL_MS);
      }

      try {
        lastResponse = await this.client.getDispatch(dispatchId);
        log.debug("rwx.dispatch_polled", {
          session_id: sessionId,
          dispatch_id: dispatchId,
          status: lastResponse.status,
          attempt: i + 1,
        });
      } catch (error) {
        log.warn("rwx.dispatch_poll_failed", {
          session_id: sessionId,
          dispatch_id: dispatchId,
          attempt: i + 1,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (
        lastResponse.status === "ready" ||
        lastResponse.status === "dispatched" ||
        lastResponse.status === "error"
      ) {
        break;
      }
    }

    return lastResponse;
  }

  // -----------------------------------------------------------------------
  // Dispatch param assembly
  // -----------------------------------------------------------------------

  private async buildDispatchParams(config: CreateSandboxConfig): Promise<Record<string, string>> {
    // Start with user env vars (repo secrets), then overlay system vars so
    // user values cannot shadow the control-plane contract.
    const params: Record<string, string> = { ...(config.userEnvVars ?? {}) };

    const sessionConfig = buildSessionConfig(config);

    Object.assign(params, {
      slug: config.sessionId,
      SANDBOX_ID: config.sandboxId,
      CONTROL_PLANE_URL: config.controlPlaneUrl,
      SANDBOX_AUTH_TOKEN: config.sandboxAuthToken,
      REPO_OWNER: config.repoOwner,
      REPO_NAME: config.repoName,
      SESSION_CONFIG: JSON.stringify(sessionConfig),
    });

    if (config.codeServerEnabled) {
      params.CODE_SERVER_PASSWORD = await this.deriveCodeServerPassword(config.sandboxId);
    }

    if (config.agentSlackNotifyEnabled) {
      params.AGENT_SLACK_NOTIFY_ENABLED = "true";
    }

    this.injectScmParams(params);

    return params;
  }

  private injectScmParams(params: Record<string, string>): void {
    if (this.providerConfig.scmProvider === "gitlab") {
      params.VCS_HOST = "gitlab.com";
      params.VCS_CLONE_USERNAME = "oauth2";
    } else if (this.providerConfig.scmProvider === "bitbucket") {
      params.VCS_HOST = "bitbucket.org";
      params.VCS_CLONE_USERNAME = "x-token-auth";
    } else {
      params.VCS_HOST = "github.com";
      params.VCS_CLONE_USERNAME = "x-access-token";
    }
  }

  // -----------------------------------------------------------------------
  // App endpoint URL
  // -----------------------------------------------------------------------

  private buildAppEndpointUrl(sessionId: string): string {
    return `https://${sessionId}--${this.providerConfig.orgSlug}.r1.rwx.run/`;
  }

  // -----------------------------------------------------------------------
  // Code-server password
  // -----------------------------------------------------------------------

  private async deriveCodeServerPassword(sandboxId: string): Promise<string> {
    const digest = await computeHmacHex(
      `code-server:${sandboxId}`,
      this.providerConfig.codeServerPasswordSecret
    );
    return digest.slice(0, 32);
  }

  // -----------------------------------------------------------------------
  // Error classification
  // -----------------------------------------------------------------------

  private classifyError(message: string, error: unknown): SandboxProviderError {
    if (error instanceof SandboxProviderError) {
      return error;
    }
    if (error instanceof RwxApiError) {
      return SandboxProviderError.fromFetchError(
        `${message}: ${error.message}`,
        error,
        error.status
      );
    }
    return SandboxProviderError.fromFetchError(message, error);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRwxProvider(
  client: RwxRestClient,
  providerConfig: RwxProviderConfig
): RwxSandboxProvider {
  return new RwxSandboxProvider(client, providerConfig);
}
