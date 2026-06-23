import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchPreview } from "./preview-dispatch";

describe("dispatchPreview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("uses the repository key, branch ref, and caller-provided slug, polls until ready, and returns the run URL", async () => {
    vi.useFakeTimers();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ dispatch_id: "dispatch-1" }, { status: 201 }))
      .mockResolvedValueOnce(
        Response.json({
          status: "ready",
          runs: [{ run_id: "2", run_url: "https://cloud.rwx.com/mint/org/runs/2" }],
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const promise = dispatchPreview({ RWX_ACCESS_TOKEN: "token" } as never, {
      repoOwner: "onboardiq",
      repoName: "background-agents",
      branchName: "my-feature-branch",
      slug: "stable-preview-slug",
      sessionId: "session-1",
    });

    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual({
      dispatchId: "dispatch-1",
      runUrl: "https://cloud.rwx.com/mint/org/runs/2",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.rwx.com/mint/api/runs/dispatches",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          key: "onboardiq-background-agents",
          ref: "my-feature-branch",
          params: { slug: "stable-preview-slug", reason: "reef_general" },
          title: "Preview for Reef session session-1",
        }),
      })
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.rwx.com/mint/api/runs/dispatches/dispatch-1",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("returns the run URL from the create response without polling", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json(
        {
          dispatch_id: "dispatch-1",
          run_url: "https://cloud.rwx.com/mint/org/runs/3",
        },
        { status: 201 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      dispatchPreview({ RWX_ACCESS_TOKEN: "token" } as never, {
        repoOwner: "onboardiq",
        repoName: "background-agents",
        branchName: "my-feature-branch",
        slug: "stable-preview-slug",
        sessionId: "session-1",
      })
    ).resolves.toEqual({
      dispatchId: "dispatch-1",
      runUrl: "https://cloud.rwx.com/mint/org/runs/3",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.rwx.com/mint/api/runs/dispatches",
      expect.objectContaining({ method: "POST" })
    );
  });
});
