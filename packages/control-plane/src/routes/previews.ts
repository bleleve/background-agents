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
        commitSha?: string;
        slug?: string;
      }>(request);
      if (body instanceof Response) return body;
      if (!body.repoOwner || !body.repoName || !body.commitSha || !body.slug) {
        return error("repoOwner, repoName, commitSha, and slug are required");
      }
      if (!/^[0-9a-f]{40}$/i.test(body.commitSha)) return error("Invalid commitSha");
      try {
        const dispatchId = await dispatchPreview(env, {
          repoOwner: body.repoOwner.toLowerCase(),
          repoName: body.repoName.toLowerCase(),
          commitSha: body.commitSha,
          slug: body.slug,
        });
        return json({ dispatchId }, 202);
      } catch (cause) {
        return error(cause instanceof Error ? cause.message : "Preview dispatch failed", 502);
      }
    },
  },
];
