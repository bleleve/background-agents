import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { parseReviewSessionPrNumber } from "@open-inspect/shared";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import { githubBotFetch } from "@/lib/github-bot";

/**
 * Re-run the automated PR review for this session's PR. Only valid for review
 * sessions: the repo and the reviewed PR number are resolved from the session
 * itself (never trusted from the client), then delegated to the github-bot,
 * which owns the GitHub App token and the review prompt.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const sessionRes = await controlPlaneFetch(`/sessions/${id}`);
    if (!sessionRes.ok) {
      return NextResponse.json({ error: "Session not found" }, { status: sessionRes.status });
    }
    const sessionData = (await sessionRes.json()) as {
      repoOwner?: string;
      repoName?: string;
      title?: string | null;
    };

    // The reviewed PR number comes from the review session's title — this also
    // gates the action to review sessions (build/comment sessions don't match).
    const prNumber = parseReviewSessionPrNumber(sessionData.title);
    if (prNumber === null) {
      return NextResponse.json({ error: "Not a PR review session" }, { status: 400 });
    }
    if (!sessionData.repoOwner || !sessionData.repoName) {
      return NextResponse.json({ error: "Session has no associated repo" }, { status: 400 });
    }

    const user = session.user;
    const response = await githubBotFetch("/internal/reviews", {
      method: "POST",
      body: JSON.stringify({
        owner: sessionData.repoOwner,
        repo: sessionData.repoName,
        prNumber,
        requestedBy: {
          login: user.login || user.name || "reef-web",
          id: user.id || user.email || "reef-web",
          avatarUrl: user.image ?? null,
        },
      }),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Re-run review error:", error);
    return NextResponse.json({ error: "Failed to re-run review" }, { status: 500 });
  }
}
