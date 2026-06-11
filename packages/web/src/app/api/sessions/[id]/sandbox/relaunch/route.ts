import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

/**
 * Relaunch the sandbox for an existing session whose sandbox is stopped, failed,
 * or stale. The control plane resolves the right action (provider resume,
 * snapshot restore, or fresh spawn) from the current sandbox state.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const response = await controlPlaneFetch(`/sessions/${id}/sandbox/relaunch`, {
      method: "POST",
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Relaunch sandbox error:", error);
    return NextResponse.json({ error: "Failed to relaunch sandbox" }, { status: 500 });
  }
}
