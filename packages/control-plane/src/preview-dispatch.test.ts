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

  it("returns per-product preview URLs when RWX_ORG_SLUG is configured", async () => {
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
      dispatchPreview({ RWX_ACCESS_TOKEN: "token", RWX_ORG_SLUG: "fountain" } as never, {
        repoOwner: "onboardiq",
        repoName: "background-agents",
        branchName: "my-feature-branch",
        slug: "stable-preview-slug",
      })
    ).resolves.toEqual({
      dispatchId: "dispatch-1",
      runUrl: "https://cloud.rwx.com/mint/org/runs/3",
      previewUrls: {
        hire: "https://hire-stable-preview-slug--fountain.r1.rwx.run/",
        "recruiter-ui": "https://recruiter-ui-stable-preview-slug--fountain.r1.rwx.run/",
        "applicant-ui": "https://applicant-ui-stable-preview-slug--fountain.r1.rwx.run/",
        "career-site-ui": "https://career-site-ui-stable-preview-slug--fountain.r1.rwx.run/",
        wx: "https://wx-stable-preview-slug--fountain.r1.rwx.run/",
      },
    });
  });

  it("can dispatch without waiting for a run URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ dispatch_id: "dispatch-1" }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      dispatchPreview({ RWX_ACCESS_TOKEN: "token" } as never, {
        repoOwner: "onboardiq",
        repoName: "background-agents",
        branchName: "my-feature-branch",
        slug: "stable-preview-slug",
        waitForRunUrl: false,
      })
    ).resolves.toEqual({
      dispatchId: "dispatch-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the commit SHA as the dispatch ref when provided", async () => {
    vi.useFakeTimers();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ dispatch_id: "dispatch-1" }, { status: 201 }))
      .mockResolvedValueOnce(
        Response.json({
          status: "ready",
          runs: [{ run_id: "3", run_url: "https://cloud.rwx.com/mint/org/runs/3" }],
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const promise = dispatchPreview({ RWX_ACCESS_TOKEN: "token" } as never, {
      repoOwner: "onboardiq",
      repoName: "background-agents",
      branchName: "main",
      commitSha: "abc123",
      slug: "stable-preview-slug",
    });

    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual({
      dispatchId: "dispatch-1",
      runUrl: "https://cloud.rwx.com/mint/org/runs/3",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.rwx.com/mint/api/runs/dispatches",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          key: "onboardiq-background-agents",
          ref: "abc123",
          params: { slug: "stable-preview-slug", reason: "reef_general" },
        }),
      })
    );
  });
});
