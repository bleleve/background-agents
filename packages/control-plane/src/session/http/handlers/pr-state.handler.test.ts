import { describe, expect, it, vi } from "vitest";
import { createPrStateHandler } from "./pr-state.handler";
import type { ArtifactRow } from "../../types";

function createArtifact(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id: "artifact-1",
    type: "pr",
    url: "https://github.com/acme/repo/pull/42",
    metadata: JSON.stringify({ number: 42, state: "open", head: "feature", base: "main" }),
    created_at: 1000,
    ...overrides,
  };
}

function createHandler(artifacts: ArtifactRow[] = [createArtifact()]) {
  const repository = {
    listArtifacts: vi.fn(() => artifacts),
    getArtifactById: vi.fn((id: string) => artifacts.find((a) => a.id === id) ?? null),
    updateArtifactMetadata: vi.fn((id: string, metadata: string) => {
      const artifact = artifacts.find((a) => a.id === id);
      if (artifact) artifact.metadata = metadata;
    }),
  };
  const broadcast = vi.fn();
  const parseArtifactMetadata = (artifact: Pick<ArtifactRow, "id" | "metadata">) =>
    artifact.metadata ? (JSON.parse(artifact.metadata) as Record<string, unknown>) : null;

  return {
    handler: createPrStateHandler({ repository, broadcast, parseArtifactMetadata }),
    repository,
    broadcast,
  };
}

function makeRequest(state: string): Request {
  return new Request("http://internal/update-pr-state", {
    method: "POST",
    body: JSON.stringify({ state }),
  });
}

describe("createPrStateHandler", () => {
  it("updates the PR artifact state and broadcasts the change", async () => {
    const { handler, repository, broadcast } = createHandler();

    const response = await handler.updatePrState(makeRequest("closed"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    expect(repository.updateArtifactMetadata).toHaveBeenCalledWith(
      "artifact-1",
      JSON.stringify({ number: 42, state: "closed", head: "feature", base: "main" })
    );
    expect(broadcast).toHaveBeenCalledWith({
      type: "artifact_created",
      artifact: {
        id: "artifact-1",
        type: "pr",
        url: "https://github.com/acme/repo/pull/42",
        metadata: { number: 42, state: "closed", head: "feature", base: "main" },
        createdAt: 1000,
      },
    });
  });

  it("rejects invalid states", async () => {
    const { handler, repository, broadcast } = createHandler();
    const response = await handler.updatePrState(makeRequest("merged_or_something"));
    expect(response.status).toBe(400);
    expect(repository.updateArtifactMetadata).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("returns 404 when there is no pr artifact", async () => {
    const { handler } = createHandler([]);
    const response = await handler.updatePrState(makeRequest("closed"));
    expect(response.status).toBe(404);
  });
});
