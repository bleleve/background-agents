import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchIssueDetails, normalizeLinearCommentBody } from "./linear-client";

describe("normalizeLinearCommentBody", () => {
  it("prefers plain body when present", () => {
    expect(
      normalizeLinearCommentBody({
        body: "Please prioritize this fix",
        bodyData: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Ignored" }] }],
        },
      })
    ).toBe("Please prioritize this fix");
  });

  it("falls back to rich text bodyData objects", () => {
    expect(
      normalizeLinearCommentBody({
        body: "",
        bodyData: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "First line" }] },
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Second line" },
                { type: "hardBreak" },
                { type: "text", text: "continued" },
              ],
            },
          ],
        },
      })
    ).toBe("First line\nSecond line\ncontinued");
  });

  it("parses stringified rich text bodyData", () => {
    expect(
      normalizeLinearCommentBody({
        body: "",
        bodyData: JSON.stringify({
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "From JSON" }] }],
        }),
      })
    ).toBe("From JSON");
  });
});

describe("fetchIssueDetails", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("normalizes comment body from bodyData when body is empty", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          issue: {
            id: "issue-1",
            identifier: "ENG-123",
            title: "Test issue",
            description: "Desc",
            url: "https://linear.app/acme/issue/ENG-123/test",
            priority: 0,
            priorityLabel: "No priority",
            labels: { nodes: [] },
            project: null,
            assignee: null,
            team: { id: "team-1", key: "ENG", name: "Engineering" },
            comments: {
              nodes: [
                {
                  body: "",
                  bodyData: {
                    type: "doc",
                    content: [
                      { type: "paragraph", content: [{ type: "text", text: "Rich text comment" }] },
                    ],
                  },
                  user: { name: "Martin Roberts" },
                },
              ],
            },
          },
        },
      }),
    }) as typeof globalThis.fetch;

    const issue = await fetchIssueDetails({ accessToken: "test-token" }, "issue-1");

    expect(issue?.comments).toEqual([
      {
        body: "Rich text comment",
        user: { name: "Martin Roberts" },
      },
    ]);

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(init?.body)).toContain("bodyData");
  });
});
