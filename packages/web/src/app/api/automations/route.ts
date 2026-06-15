import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { getToken } from "next-auth/jwt";
import { authOptions } from "@/lib/auth";
import { buildAuthIdentity, buildScmCredentials } from "@/lib/build-auth-identity";
import { controlPlaneFetch } from "@/lib/control-plane";
import {
  AUTOMATION_CONTROL_PLANE_QUERY_PARAMS,
  buildControlPlanePath,
} from "@/lib/control-plane-query";
import { buildAutomationActorQueryParams } from "@/lib/automation-actor";
import { resolveCurrentUserId } from "@/lib/current-user";
import { CURRENT_USER_CREATED_BY } from "@/lib/automation-list";

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const searchParams = new URLSearchParams(request.nextUrl.searchParams);

    const createdByValues = searchParams.getAll("createdBy");
    if (createdByValues.includes(CURRENT_USER_CREATED_BY)) {
      const resolved = await resolveCurrentUserId(session.user);
      if (!resolved.ok) {
        return NextResponse.json(resolved.body, { status: resolved.status });
      }

      searchParams.delete("createdBy");
      for (const value of createdByValues) {
        searchParams.append(
          "createdBy",
          value === CURRENT_USER_CREATED_BY ? resolved.userId : value
        );
      }
    }

    const actorParams = buildAutomationActorQueryParams(session);
    for (const [key, value] of actorParams.entries()) {
      searchParams.set(key, value);
    }

    const path = buildControlPlanePath(
      "/automations",
      searchParams,
      AUTOMATION_CONTROL_PLANE_QUERY_PARAMS
    );

    const response = await controlPlaneFetch(path);
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch automations:", error);
    return NextResponse.json({ error: "Failed to fetch automations" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();

    const jwt = await getToken({ req: request });

    // Derive identity from the server-side NextAuth session, routed through the
    // shared chokepoint (same as the sessions/ws-token routes): provider-agnostic
    // auth* resolves the canonical user for BOTH GitHub and Google, while the
    // GitHub-only scm* block is empty for Google — so a Google sub never reaches
    // the SCM path (F1/F2).
    const user = session.user;
    const userId = user.id || user.email || "anonymous";

    const response = await controlPlaneFetch("/automations", {
      method: "POST",
      body: JSON.stringify({
        ...body,
        userId,
        ...buildAuthIdentity(user),
        ...buildScmCredentials(user, jwt),
      }),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to create automation:", error);
    return NextResponse.json({ error: "Failed to create automation" }, { status: 500 });
  }
}
