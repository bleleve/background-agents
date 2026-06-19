import type { ServerMessage } from "@open-inspect/shared";
import type { SessionRepository } from "../../repository";
import type { ArtifactRow } from "../../types";

const VALID_PR_STATES = new Set(["open", "closed", "merged", "draft"]);

export interface PrStateHandlerDeps {
  repository: Pick<
    SessionRepository,
    "listArtifacts" | "getArtifactById" | "updateArtifactMetadata"
  >;
  broadcast: (message: ServerMessage) => void;
  parseArtifactMetadata: (
    artifact: Pick<ArtifactRow, "id" | "metadata">
  ) => Record<string, unknown> | null;
}

export interface PrStateHandler {
  updatePrState: (request: Request) => Promise<Response>;
}

export function createPrStateHandler(deps: PrStateHandlerDeps): PrStateHandler {
  return {
    async updatePrState(request: Request): Promise<Response> {
      let body: { state?: unknown };
      try {
        body = (await request.json()) as { state?: unknown };
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }

      const state = body.state;
      if (typeof state !== "string" || !VALID_PR_STATES.has(state)) {
        return Response.json(
          { error: "state must be one of open, closed, merged, draft" },
          { status: 400 }
        );
      }

      const artifacts = deps.repository.listArtifacts();
      const prArtifact = artifacts.find((artifact) => artifact.type === "pr");
      if (!prArtifact) {
        return Response.json({ error: "pr artifact not found" }, { status: 404 });
      }

      const metadata = deps.parseArtifactMetadata(prArtifact) ?? {};
      const updatedMetadata = { ...metadata, state };
      deps.repository.updateArtifactMetadata(prArtifact.id, JSON.stringify(updatedMetadata));

      const updatedArtifact = deps.repository.getArtifactById(prArtifact.id);
      if (updatedArtifact) {
        deps.broadcast({
          type: "artifact_created",
          artifact: {
            id: updatedArtifact.id,
            type: updatedArtifact.type,
            url: updatedArtifact.url,
            metadata: deps.parseArtifactMetadata(updatedArtifact),
            createdAt: updatedArtifact.created_at,
          },
        });
      }

      return Response.json({ ok: true });
    },
  };
}
