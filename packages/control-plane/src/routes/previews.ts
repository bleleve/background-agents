import { dispatchPreview } from "../preview-dispatch";
import { error, json, parseJsonBody, parsePattern, type Route } from "./shared";

export const previewRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/previews/dispatch"),
    handler: async (request, env) => {
      const body = await parseJsonBody<{
        repoOwner?: string;
        repoName?: string;
        branchName?: string;
        slug?: string;
        reason?: string;
      }>(request);
      if (body instanceof Response) return body;
      if (!body.repoOwner || !body.repoName || !body.branchName || !body.slug) {
        return error("repoOwner, repoName, branchName, and slug are required");
      }
      try {
        const { dispatchId, runUrl } = await dispatchPreview(env, {
          repoOwner: body.repoOwner.toLowerCase(),
          repoName: body.repoName.toLowerCase(),
          branchName: body.branchName,
          slug: body.slug,
          reason: body.reason,
        });
        return json({ dispatchId, runUrl }, 202);
      } catch (cause) {
        return error(cause instanceof Error ? cause.message : "Preview dispatch failed", 502);
      }
    },
  },
];
