/**
 * validate-suggestion — Tier-0 post-splice syntax validation for ```suggestion blocks.
 *
 * Fetches the PR-head file, splices the proposed replacement into the anchored
 * range, and checks whether the result parses cleanly (tree-sitter, error-
 * recovering). A FAIL means the block would produce a syntax/delimiter/
 * indentation break when applied; the agent should re-anchor or downgrade to prose.
 *
 * IMPORTANT guarantee: "valid at headSHA at post time", NOT "valid at apply time".
 * GitHub applies the suggestion to the branch at the moment of the click, which may
 * have advanced since this check ran. The eligibility gate + footer disclaimer in the
 * review prompt are the load-bearing defense; this tool is an additional filter.
 *
 * Until reconstruction fidelity is proven empirically against real PRs (see docs/plans/
 * safe-apply-suggestions.md smoke-test requirement), a FAIL should WARN rather
 * than hard-block posting. The agent decides whether to post or downgrade.
 *
 * Gated by AGENT_TOOL_VALIDATE_SUGGESTION_JS env var (set via agentToolFlags).
 * Requires web-tree-sitter globally installed (bundled in the image).
 */
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

const execFile = promisify(execFileCb);

const MAX_FILE_BYTES = 1_048_576;
const GH_TIMEOUT_MS = 20_000;

/** Validate owner/repo against the session and path for safety. Returns error string or null. */
function validateRepoAndPath(owner, repo, path) {
  let sessionOwner, sessionRepo;
  try {
    const cfg = JSON.parse(process.env.SESSION_CONFIG || "{}");
    sessionOwner = (cfg.repo_owner || "").toLowerCase();
    sessionRepo = (cfg.repo_name || "").toLowerCase();
  } catch {
    return "Cannot parse SESSION_CONFIG — aborting to prevent unintended API access.";
  }
  if (!sessionOwner || !sessionRepo) {
    return "Session repo context unavailable — cannot validate owner/repo.";
  }
  if (owner.toLowerCase() !== sessionOwner || repo.toLowerCase() !== sessionRepo) {
    return `owner/repo mismatch: tool may only access the session repo (${sessionOwner}/${sessionRepo}).`;
  }
  if (!/^[a-zA-Z0-9._\-\/]+$/.test(path) || path.includes("..") || path.startsWith("/")) {
    return `path "${path}" is not a valid relative file path.`;
  }
  return null;
}

export default tool({
  name: "validate-suggestion",
  description:
    "Fetch the PR-head file, splice the proposed suggestion replacement into the anchored range, and verify the result parses without syntax errors (tree-sitter Tier-0). Returns {valid: true/false, errorDetail, note}. A false result means the suggestion block would break syntax when applied — consider re-anchoring or downgrading to prose.",
  args: {
    owner: z.string(),
    repo: z.string(),
    headSha: z.string().describe("PR head commit SHA (40 hex chars)."),
    path: z.string().describe("File path within the repo (must be in the PR diff)."),
    startLine: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("First line of the replacement range (1-based). Omit for single-line."),
    line: z.number().int().positive().describe("Last line of the replacement range (1-based)."),
    replacement: z
      .string()
      .describe(
        "The full text of the ```suggestion block content (the lines that replace the anchored range)."
      ),
    language: z
      .enum(["typescript", "javascript", "ruby", "python", "go", "rust", "other"])
      .optional(),
  },
  async execute(args) {
    const { owner, repo, headSha, path, startLine, line, replacement, language } = args;

    const repoErr = validateRepoAndPath(owner, repo, path);
    if (repoErr) {
      return JSON.stringify({ valid: null, errorDetail: repoErr, note: "validation skipped" });
    }

    if (!/^[0-9a-f]{40}$/i.test(headSha)) {
      return JSON.stringify({
        valid: null,
        errorDetail: "headSha must be a 40-char hex SHA.",
        note: "validation skipped",
      });
    }

    const firstLine = startLine ?? line;
    const lastLine = line;
    if (firstLine > lastLine) {
      return JSON.stringify({
        valid: null,
        errorDetail: "startLine must be ≤ line.",
        note: "validation skipped",
      });
    }

    // Fetch file content.
    let fileContent;
    try {
      const { stdout } = await execFile(
        "gh",
        [
          "api",
          `repos/${owner}/${repo}/contents/${path}?ref=${headSha}`,
          "--jq",
          ".content // empty",
        ],
        { timeout: GH_TIMEOUT_MS, maxBuffer: MAX_FILE_BYTES * 2 }
      );
      if (!stdout.trim()) {
        return JSON.stringify({
          valid: null,
          errorDetail: "File not fetchable (binary, missing, or too large).",
          note: "validation skipped",
        });
      }
      fileContent = Buffer.from(stdout.trim().replace(/\n/g, ""), "base64").toString("utf-8");
    } catch (err) {
      return JSON.stringify({
        valid: null,
        errorDetail: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        note: "validation skipped",
      });
    }

    if (Buffer.byteLength(fileContent, "utf-8") > MAX_FILE_BYTES) {
      return JSON.stringify({
        valid: null,
        errorDetail: "File too large for validation.",
        note: "validation skipped — use manual review",
      });
    }

    // Splice replacement into the anchored range (1-based, inclusive).
    const originalLines = fileContent.split("\n");
    const before = originalLines.slice(0, firstLine - 1);
    const after = originalLines.slice(lastLine);
    const replacementLines = replacement.split("\n");
    const splicedContent = [...before, ...replacementLines, ...after].join("\n");

    // Detect language from extension.
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    const lang =
      language ??
      (["ts", "tsx"].includes(ext)
        ? "typescript"
        : ["js", "mjs", "cjs", "jsx"].includes(ext)
          ? "javascript"
          : ext === "rb"
            ? "ruby"
            : ext === "py"
              ? "python"
              : ext === "go"
                ? "go"
                : ext === "rs"
                  ? "rust"
                  : "other");

    // Try tree-sitter parse.
    try {
      const Parser = (await import("web-tree-sitter")).default;
      await Parser.init();

      const grammarMap = {
        typescript: "tree-sitter-typescript",
        javascript: "tree-sitter-javascript",
        ruby: "tree-sitter-ruby",
        python: "tree-sitter-python",
        go: "tree-sitter-go",
        rust: "tree-sitter-rust",
      };

      const grammarPkg = grammarMap[lang];
      if (!grammarPkg) {
        return JSON.stringify({
          valid: null,
          errorDetail: `No grammar for ${lang}.`,
          note: "validation skipped",
        });
      }

      let wasmPath;
      try {
        const pkgDir = require.resolve(`${grammarPkg}/package.json`).replace("/package.json", "");
        const fs = await import("fs");
        const wasmFile = fs.readdirSync(pkgDir).find((f) => f.endsWith(".wasm"));
        if (!wasmFile) throw new Error("no .wasm");
        wasmPath = `${pkgDir}/${wasmFile}`;
      } catch {
        return JSON.stringify({
          valid: null,
          errorDetail: "Grammar WASM not found in image.",
          note: "validation skipped — image may need rebuild with web-tree-sitter",
        });
      }

      const Language = await Parser.Language.load(wasmPath);
      const parser = new Parser();
      parser.setLanguage(Language);
      const tree = parser.parse(splicedContent);

      if (tree.rootNode.hasError()) {
        // Find first ERROR node for a useful message.
        let errorNode = null;
        function findError(node) {
          if (node.type === "ERROR" || node.isMissing) {
            errorNode = node;
            return;
          }
          for (const child of node.children) {
            if (!errorNode) findError(child);
          }
        }
        findError(tree.rootNode);
        const detail = errorNode
          ? `Syntax error near line ${errorNode.startPosition.row + 1}: "${errorNode.text?.slice(0, 60)}"`
          : "Syntax errors detected in spliced result.";
        return JSON.stringify({
          valid: false,
          errorDetail: detail,
          note: "WARN: the spliced content has syntax errors. Consider re-anchoring or downgrading to prose. Guarantee: valid at headSHA at post time only.",
        });
      }

      return JSON.stringify({
        valid: true,
        errorDetail: null,
        note: "Spliced content parsed cleanly (Tier-0 syntax only). Guarantee: valid at headSHA at post time — not at apply time if new commits have landed.",
      });
    } catch (err) {
      return JSON.stringify({
        valid: null,
        errorDetail: `tree-sitter error: ${err instanceof Error ? err.message : String(err)}`,
        note: "validation skipped",
      });
    }
  },
});
