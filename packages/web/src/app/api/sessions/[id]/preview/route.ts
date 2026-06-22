import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  try {
    const response = await controlPlaneFetch(`/sessions/${id}/preview`, {
      method: "POST",
      body: JSON.stringify({
        enabled: body.enabled,
        userId: session.user.id || session.user.email || "anonymous",
      }),
    });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch (error) {
    console.error("Preview toggle error:", error);
    return NextResponse.json({ error: "Failed to update preview" }, { status: 500 });
  }
}
