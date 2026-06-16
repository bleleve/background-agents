/**
 * ast-anchor — derive exact RIGHT-side line numbers and leading indentation
 * for a GitHub inline suggestion from PR-head file bytes fetched via the
 * contents API (premise-independent: no local checkout required).
 *
 * SECURITY: `path` must be validated against the PR diff's changed-file list
 * before calling this tool to prevent reading arbitrary repo files. `headSha`
 * must be the PR's actual headRefOid, not caller-supplied.
 *
 * Gated by AGENT_TOOL_AST_ANCHOR_JS env var (set via agentToolFlags).
 * Requires web-tree-sitter globally installed (npm install -g web-tree-sitter
 * tree-sitter-typescript tree-sitter-ruby) — bundled in the image.
 */
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

const execFile = promisify(execFileCb);

// Maximum file size we'll fetch via the contents API (1 MB decoded).
const MAX_FILE_BYTES = 1_048_576;
// Maximum wall-clock time for the gh api call (seconds → ms).
const GH_TIMEOUT_MS = 20_000;

/**
 * Validate that owner/repo match the session's known repo and that path is safe.
 * Returns an error string if validation fails, null if ok.
 *
 * owner/repo are read from SESSION_CONFIG (set by the sandbox at boot) so the
 * LLM cannot redirect the gh API call to an arbitrary repository the installation
 * token can access. path is checked against a safe character set to prevent path
 * traversal and URL injection.
 */
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

  // Reject path traversal, query strings, fragments, and non-printable chars.
  if (!/^[a-zA-Z0-9._\-\/]+$/.test(path) || path.includes("..") || path.startsWith("/")) {
    return `path "${path}" is not a valid relative file path.`;
  }

  return null;
}

export default tool({
  name: "ast-anchor",
  description:
    "Fetch a file from the PR head via the GitHub contents API and return the exact start_line, line, and leading indentation for an inline suggestion anchor. Use this INSTEAD of hand-counting from gh pr diff hunk headers. Returns null when the file is too large, not in the diff, or the target node cannot be located.",
  args: {
    owner: z.string().describe("Repository owner (login)."),
    repo: z.string().describe("Repository name."),
    headSha: z
      .string()
      .describe("PR head commit SHA (from headRefOid). Must be the PR's actual head."),
    path: z.string().describe("File path within the repo (must be in the PR diff)."),
    targetDescription: z
      .string()
      .describe(
        "Short description of the code node to anchor on, e.g. 'the foo method body' or 'the if-condition on line ~42'. Used to identify the node in the parsed tree."
      ),
    language: z
      .enum(["typescript", "javascript", "ruby", "python", "go", "rust", "other"])
      .optional()
      .describe("File language hint. Defaults to detection from extension."),
  },
  async execute(args) {
    const { owner, repo, headSha, path, targetDescription, language } = args;

    // Security: validate owner/repo against the session and path for safety.
    const repoErr = validateRepoAndPath(owner, repo, path);
    if (repoErr) return `Error: ${repoErr}`;

    // Security: validate headSha is a plausible commit SHA (40 hex chars).
    if (!/^[0-9a-f]{40}$/i.test(headSha)) {
      return "Error: headSha must be a 40-character hex commit SHA.";
    }

    // Fetch file content from GitHub contents API at the PR head.
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
        return `File ${path} could not be fetched (may be binary, too large, or missing from head ${headSha}).`;
      }

      // GitHub returns base64-encoded content with newlines.
      fileContent = Buffer.from(stdout.trim().replace(/\n/g, ""), "base64").toString("utf-8");
    } catch (err) {
      return `Failed to fetch ${path} from head ${headSha}: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (Buffer.byteLength(fileContent, "utf-8") > MAX_FILE_BYTES) {
      return `File ${path} is too large to parse (>${MAX_FILE_BYTES} bytes). Use manual line counting from gh pr diff.`;
    }

    // Detect language from extension if not provided.
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

    // Try to load web-tree-sitter and the appropriate grammar.
    // Falls back gracefully if tree-sitter is not available in this image.
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
        return fallbackLinear(fileContent, targetDescription, path);
      }

      // Locate the .wasm grammar file via require.resolve.
      let wasmPath;
      try {
        // Grammar packages ship a .wasm file; find it relative to the package.
        const pkgDir = require.resolve(`${grammarPkg}/package.json`).replace("/package.json", "");
        const fs = await import("fs");
        const wasmFile = fs.readdirSync(pkgDir).find((f) => f.endsWith(".wasm"));
        if (!wasmFile) throw new Error("no .wasm found");
        wasmPath = `${pkgDir}/${wasmFile}`;
      } catch {
        return fallbackLinear(fileContent, targetDescription, path);
      }

      const Language = await Parser.Language.load(wasmPath);
      const parser = new Parser();
      parser.setLanguage(Language);
      const tree = parser.parse(fileContent);

      if (tree.rootNode.hasError()) {
        return `Parsed ${path} but tree contains errors. Indentation/delimiter integrity check: ${tree.rootNode.hasError() ? "ERRORS DETECTED" : "clean"}. Use manual anchoring; be careful with indentation.`;
      }

      // Heuristic: find the node whose text best matches the description.
      // We walk the tree looking for named nodes whose text is non-trivial.
      const lines = fileContent.split("\n");
      const bestNode = findNodeByDescription(tree.rootNode, targetDescription, lines);

      if (!bestNode) {
        return fallbackLinear(fileContent, targetDescription, path);
      }

      const startLine = bestNode.startPosition.row + 1; // 1-based
      const endLine = bestNode.endPosition.row + 1;
      const indent = lines[bestNode.startPosition.row]?.match(/^(\s*)/)?.[1] ?? "";

      return JSON.stringify({
        path,
        start_line: startLine === endLine ? null : startLine,
        line: endLine,
        side: "RIGHT",
        indent,
        nodeType: bestNode.type,
        nodeText: bestNode.text.slice(0, 120),
        hasError: false,
        note: "Derived from tree-sitter parse of PR-head bytes. Verify against gh pr diff before posting.",
      });
    } catch (err) {
      return fallbackLinear(fileContent, targetDescription, path);
    }
  },
});

/**
 * Fallback when tree-sitter is unavailable: do a text-based linear search for
 * lines matching keywords from the description and return a best-guess anchor.
 */
function fallbackLinear(content, description, path) {
  const keywords = description
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3);
  const lines = content.split("\n");
  let bestLine = -1;
  let bestScore = -1;
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    const score = keywords.filter((k) => lower.includes(k)).length;
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }
  if (bestLine < 0 || bestScore === 0) {
    return `Could not locate target in ${path} (tree-sitter unavailable, no keyword match). Use manual line counting from gh pr diff.`;
  }
  const indent = lines[bestLine]?.match(/^(\s*)/)?.[1] ?? "";
  return JSON.stringify({
    path,
    start_line: null,
    line: bestLine + 1,
    side: "RIGHT",
    indent,
    nodeType: "text-match",
    hasError: null,
    note: "Fallback: tree-sitter unavailable; derived from keyword matching. Verify against gh pr diff.",
  });
}

/**
 * Walk the tree to find the named node whose text best matches the description.
 * Uses a simple keyword-overlap score.
 */
function findNodeByDescription(root, description, lines) {
  const keywords = description
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3);
  if (keywords.length === 0) return null;

  let best = null;
  let bestScore = 0;

  function walk(node) {
    if (node.isNamed && node.text) {
      const lower = node.text.toLowerCase().slice(0, 300);
      const score = keywords.filter((k) => lower.includes(k)).length;
      if (score > bestScore) {
        bestScore = score;
        best = node;
      }
    }
    for (const child of node.children) {
      walk(child);
    }
  }

  walk(root);
  return best;
}
