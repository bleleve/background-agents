import { createLogger } from "./logger";
import { createRwxRestClient } from "./sandbox/rwx-rest-client";
import type { Env } from "./types";

const log = createLogger("preview-dispatch");

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 120_000;

export interface DispatchPreviewResult {
  dispatchId: string;
  runUrl: string;
}

export async function dispatchPreview(
  env: Env,
  input: {
    repoOwner: string;
    repoName: string;
    branchName: string;
    slug: string;
    sessionId?: string;
    reason?: string;
  }
): Promise<DispatchPreviewResult> {
  if (!env.RWX_ACCESS_TOKEN) throw new Error("RWX_ACCESS_TOKEN is required for preview dispatches");

  const client = createRwxRestClient({
    apiToken: env.RWX_ACCESS_TOKEN,
    baseUrl: env.RWX_BASE_URL,
  });

  const params: Record<string, string> = { slug: input.slug };
  if (input.reason) params["reason"] = input.reason;

  const result = await client.createDispatch({
    key: `${input.repoOwner}-${input.repoName}`,
    ref: input.branchName,
    params,
    title: input.sessionId ? `Preview for Reef session ${input.sessionId}` : undefined,
  });
  log.info("preview.dispatched", { ...input, dispatch_id: result.dispatch_id });

  const startMs = Date.now();
  while (Date.now() - startMs < POLL_TIMEOUT_MS) {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const dispatch = await client.getDispatch(result.dispatch_id);
    if (dispatch.status === "ready" && dispatch.runs.length > 0) {
      const runUrl = dispatch.runs[0].run_url;
      log.info("preview.dispatch_ready", {
        ...input,
        dispatch_id: result.dispatch_id,
        run_url: runUrl,
      });
      return { dispatchId: result.dispatch_id, runUrl };
    }
    if (dispatch.error) {
      throw new Error(`Dispatch failed: ${dispatch.error}`);
    }
  }
  throw new Error(`Dispatch timed out after ${POLL_TIMEOUT_MS / 1000}s`);
}
