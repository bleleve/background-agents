/**
 * Tool that downloads a user-uploaded file artifact from the control plane
 * and saves it to the sandbox filesystem.
 *
 * Users upload files via the web interface; the sandbox agent uses this tool
 * to retrieve them by artifact ID and write them to a specified path.
 */
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { bridgeFetch, extractError } from "./_bridge-client.js";

export default tool({
  name: "download_file",
  description:
    "Download a user-uploaded file from the session and save it to a path in the sandbox filesystem. " +
    "Use this tool when the user has uploaded files via the web interface and you need to access them. " +
    "The artifact ID is provided in the conversation when files are uploaded. " +
    "If no destination path is provided, the file is saved to /tmp/<original-filename>.",
  args: {
    artifact_id: z
      .string()
      .describe("The artifact ID of the uploaded file (provided when the user uploads a file)."),
    destination_path: z
      .string()
      .optional()
      .describe(
        "Local filesystem path where the file should be saved. " +
          "Defaults to /tmp/<original-filename> if not specified."
      ),
  },
  async execute(args) {
    let response;
    try {
      response = await bridgeFetch(`/files/${args.artifact_id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ ok: false, error: `Failed to reach control plane: ${message}` });
    }

    if (!response.ok) {
      const errorMessage = await extractError(response);
      return JSON.stringify({
        ok: false,
        error: `Failed to download file (HTTP ${response.status}): ${errorMessage}`,
      });
    }

    // Derive the file name from Content-Disposition if present, else from artifact ID
    let fileName = `file-${args.artifact_id}`;
    const disposition = response.headers.get("Content-Disposition");
    if (disposition) {
      const match = disposition.match(/filename="?([^";\n]+)"?/i);
      if (match?.[1]) {
        fileName = match[1].trim();
      }
    }

    const destinationPath = args.destination_path ?? `/tmp/${fileName}`;

    try {
      // Ensure parent directory exists
      await mkdir(dirname(destinationPath), { recursive: true });

      const fileStream = createWriteStream(destinationPath);
      // response.body is a Web Streams ReadableStream; convert to Node.js Readable
      await pipeline(Readable.fromWeb(response.body), fileStream);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ ok: false, error: `Failed to write file: ${message}` });
    }

    const contentLength = response.headers.get("Content-Length");
    const sizeNote = contentLength ? ` (${Number(contentLength).toLocaleString()} bytes)` : "";

    return JSON.stringify({
      ok: true,
      path: destinationPath,
      fileName,
      message: `File downloaded successfully to ${destinationPath}${sizeNote}`,
    });
  },
});
