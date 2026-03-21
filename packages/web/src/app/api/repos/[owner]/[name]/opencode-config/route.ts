import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ owner: string; name: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { owner, name } = await params;

  try {
    const response = await controlPlaneFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/opencode-config`
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch repo opencode config:", error);
    return NextResponse.json({ error: "Failed to fetch repo opencode config" }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ owner: string; name: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { owner, name } = await params;

  try {
    const body = await request.json();

    const response = await controlPlaneFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/opencode-config`,
      {
        method: "PUT",
        body: JSON.stringify(body),
      }
    );

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to update repo opencode config:", error);
    return NextResponse.json({ error: "Failed to update repo opencode config" }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ owner: string; name: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { owner, name } = await params;

  try {
    const response = await controlPlaneFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/opencode-config`,
      {
        method: "DELETE",
      }
    );

    if (response.status === 204) {
      return new NextResponse(null, { status: 204 });
    }

    return new NextResponse(null, { status: response.status });
  } catch (error) {
    console.error("Failed to delete repo opencode config:", error);
    return NextResponse.json({ error: "Failed to delete repo opencode config" }, { status: 500 });
  }
}
