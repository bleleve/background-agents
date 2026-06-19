import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchPreview } from "./preview-dispatch";

describe("dispatchPreview", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the repository key, commit SHA, and caller-provided slug", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ dispatch_id: "dispatch-1" }, { status: 201 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      dispatchPreview({ RWX_ACCESS_TOKEN: "token" } as never, {
        repoOwner: "onboardiq",
        repoName: "background-agents",
        commitSha: "a".repeat(40),
        slug: "stable-preview-slug",
        sessionId: "session-1",
      })
    ).resolves.toBe("dispatch-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.rwx.com/mint/api/runs/dispatches",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          key: "onboardiq-background-agents",
          params: { "commit-sha": "a".repeat(40), slug: "stable-preview-slug" },
          title: "Preview for Reef session session-1",
        }),
      })
    );
  });
});
