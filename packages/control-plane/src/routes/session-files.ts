import type { FileUploadArtifactMetadata } from "@open-inspect/shared";
import { generateId } from "../auth/crypto";
import { createLogger } from "../logger";
import {
  buildFileUploadObjectKey,
  FILE_UPLOAD_MAX_BYTES,
  FILE_UPLOAD_LIMIT_PER_SESSION,
  isMultipartFile,
} from "../media";
import { SessionInternalPaths } from "../session/contracts";
import { createMediaObjectStorage } from "../storage/object-storage";
import type { Env } from "../types";
import {
  listSessionArtifactsFromRuntime,
  getSessionArtifactFromRuntime,
} from "./session-media-artifacts";
import { error, json, parsePattern, type Route } from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";

const logger = createLogger("router:session-files");

async function handleFileUpload(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return error("Invalid multipart form data", 400);
  }

  const fileEntry = formData.get("file");
  if (!isMultipartFile(fileEntry)) {
    return error("file is required", 400);
  }

  if (fileEntry.size <= 0) {
    return error("Uploaded file is empty", 400);
  }

  if (fileEntry.size > FILE_UPLOAD_MAX_BYTES) {
    return error(`File uploads must be ${FILE_UPLOAD_MAX_BYTES} bytes or smaller`, 400);
  }

  const rawFileName =
    typeof (fileEntry as unknown as { name?: string }).name === "string" &&
    (fileEntry as unknown as { name: string }).name.length > 0
      ? (fileEntry as unknown as { name: string }).name
      : "upload";

  // Reject path traversal or null bytes in file names
  // eslint-disable-next-line no-control-regex
  if (/[\x00/\\]/.test(rawFileName)) {
    return error("Invalid file name", 400);
  }

  const fileName = rawFileName.slice(0, 255);
  const mimeType = fileEntry.type || "application/octet-stream";

  const artifactsResult = await listSessionArtifactsFromRuntime(sessionId, ctx);
  if (artifactsResult instanceof Response) return artifactsResult;

  const fileUploadCount = artifactsResult.filter((a) => a.type === "file_upload").length;
  if (fileUploadCount >= FILE_UPLOAD_LIMIT_PER_SESSION) {
    return error(
      `Session file upload limit of ${FILE_UPLOAD_LIMIT_PER_SESSION} uploads exceeded`,
      429
    );
  }

  const artifactId = generateId();
  const objectKey = buildFileUploadObjectKey(sessionId, artifactId, fileName);
  const bytes = new Uint8Array(await fileEntry.arrayBuffer());

  const metadata: FileUploadArtifactMetadata = {
    objectKey,
    fileName,
    mimeType,
    sizeBytes: bytes.byteLength,
  };

  const storage = createMediaObjectStorage(env);
  await storage.put(objectKey, bytes, { contentType: mimeType });

  const createArtifactResponse = await ctx.sessionRuntime.fetch(
    sessionId,
    SessionInternalPaths.createFileArtifact,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artifactId, objectKey, fileName, metadata }),
    }
  );

  if (!createArtifactResponse.ok) {
    try {
      await storage.delete(objectKey);
    } catch (cleanupError) {
      logger.error("file_upload.cleanup_failed", {
        session_id: sessionId,
        artifact_id: artifactId,
        object_key: objectKey,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
        error: cleanupError instanceof Error ? cleanupError : String(cleanupError),
      });
    }

    const responseText = await createArtifactResponse.text();
    let doErrorMessage = "Failed to persist file artifact";
    if (responseText) {
      try {
        const parsed = JSON.parse(responseText) as { error?: unknown };
        if (typeof parsed.error === "string" && parsed.error.trim()) {
          doErrorMessage = parsed.error;
        }
      } catch {
        doErrorMessage = responseText;
      }
    }

    if (createArtifactResponse.status >= 500) {
      logger.error("file_upload.create_artifact_failed", {
        session_id: sessionId,
        artifact_id: artifactId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
        error: doErrorMessage,
      });
      return error("Failed to persist file artifact", 500);
    }

    return error(doErrorMessage, createArtifactResponse.status);
  }

  return json({ artifactId, objectKey, fileName }, 201);
}

async function handleFileDownload(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  const artifactId = match.groups?.artifactId;
  if (!sessionId || !artifactId) {
    return error("Session ID and artifact ID are required", 400);
  }
  if (!/^[A-Za-z0-9-]+$/.test(artifactId)) {
    return error("Invalid artifact ID", 400);
  }

  const artifact = await getSessionArtifactFromRuntime(sessionId, artifactId, ctx);
  if (artifact instanceof Response) return artifact;
  if (!artifact || artifact.type !== "file_upload" || !artifact.url) {
    return error("File artifact not found", 404);
  }

  const storage = createMediaObjectStorage(env);
  const object = await storage.get(artifact.url);
  if (!object) {
    logger.warn("file_download.object_missing", {
      session_id: sessionId,
      artifact_id: artifactId,
      object_key: artifact.url,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("File artifact not found", 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);

  const fileName =
    typeof artifact.metadata?.fileName === "string" ? artifact.metadata.fileName : "download";
  const safeFileName = fileName.replace(/[^a-zA-Z0-9._\- ]/g, "_");
  headers.set("Content-Disposition", `attachment; filename="${safeFileName}"`);
  headers.set("Content-Length", String(object.size));

  if (!headers.has("Content-Type")) {
    const storedMimeType =
      typeof artifact.metadata?.mimeType === "string"
        ? artifact.metadata.mimeType
        : "application/octet-stream";
    headers.set("Content-Type", storedMimeType);
  }

  return new Response(object.body, { headers });
}

export const sessionFileRoutes: Route[] = [
  sessionRoute({
    method: "POST",
    pattern: parsePattern("/sessions/:id/files"),
    handler: handleFileUpload,
  }),
  sessionRoute({
    method: "GET",
    pattern: parsePattern("/sessions/:id/files/:artifactId"),
    handler: handleFileDownload,
  }),
];
