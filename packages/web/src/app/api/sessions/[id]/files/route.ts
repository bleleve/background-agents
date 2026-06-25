import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

const SESSION_ID_PATTERN = /^[A-Za-z0-9-]+$/;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: sessionId } = await params;
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return NextResponse.json({ error: "Invalid session ID" }, { status: 400 });
  }

  try {
    // Stream the multipart form data through to the control plane
    const contentType = request.headers.get("Content-Type");
    const response = await controlPlaneFetch(`/sessions/${sessionId}/files`, {
      method: "POST",
      body: request.body,
      // Pass the Content-Type header so the boundary is preserved
      headers: contentType ? { "Content-Type": contentType } : {},
      // Required for streaming body in Node.js environments
      duplex: "half",
    } as RequestInit & { duplex?: string });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("File upload error:", error);
    return NextResponse.json({ error: "Failed to upload file" }, { status: 500 });
  }
}
