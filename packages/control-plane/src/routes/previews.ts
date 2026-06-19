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
      }>(request);
      if (body instanceof Response) return body;
      if (!body.repoOwner || !body.repoName || !body.branchName || !body.slug) {
        return error("repoOwner, repoName, branchName, and slug are required");
      }
      try {
        const dispatchId = await dispatchPreview(env, {
          repoOwner: body.repoOwner.toLowerCase(),
          repoName: body.repoName.toLowerCase(),
          branchName: body.branchName,
          slug: body.slug,
        });
        return json({ dispatchId }, 202);
      } catch (cause) {
        return error(cause instanceof Error ? cause.message : "Preview dispatch failed", 502);
      }
    },
  },
];
