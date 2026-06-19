import { createLogger } from "./logger";
import { createRwxRestClient } from "./sandbox/rwx-rest-client";
import type { Env } from "./types";

const log = createLogger("preview-dispatch");

export async function dispatchPreview(
  env: Env,
  input: {
    repoOwner: string;
    repoName: string;
    branchName: string;
    slug: string;
    sessionId?: string;
  }
): Promise<string> {
  if (!env.RWX_ACCESS_TOKEN) throw new Error("RWX_ACCESS_TOKEN is required for preview dispatches");

  const result = await createRwxRestClient({
    apiToken: env.RWX_ACCESS_TOKEN,
    baseUrl: env.RWX_BASE_URL,
  }).createDispatch({
    key: `${input.repoOwner}-${input.repoName}`,
    ref: input.branchName,
    params: { slug: input.slug },
    title: input.sessionId ? `Preview for Reef session ${input.sessionId}` : undefined,
  });
  log.info("preview.dispatched", { ...input, dispatch_id: result.dispatch_id });
  return result.dispatch_id;
}
