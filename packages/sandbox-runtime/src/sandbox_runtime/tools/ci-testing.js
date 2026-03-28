/**
 * CI Testing Tool — run the repository RWX build-and-test workflow when present.
 *
 * When `.rwx/*.yml` exists, runs `rwx run .rwx/build-and-test.yml --wait --fail-fast` from the
 * repo root. No git push is required. Always run `git add` on all new/changed files before
 * ci-testing. If ci-testing reports "The patch did not include the following untracked file", the
 * run result is invalid — stage the file and re-run.
 *
 * If no RWX suite exists, directs the agent to project docs for testing.
 * repo root. No git push is required. Otherwise, directs the agent to project docs for testing.
 */
import { tool } from "@opencode-ai/plugin";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

const NO_RWX_GUIDANCE = [
  "No RWX test suite in this repository: `.rwx` is missing or it contains no `.yml` files.",
  "",
  "Run tests using the commands documented at the repo root — typically **CLAUDE.md** or **AGENTS.md** (e.g. `npm test`, `pytest`, or the project’s stated test/lint commands).",
  "",
  "If you change code, re-run those tests until they pass. Read failure output carefully and fix the underlying issues before finishing.",
].join("\n");

async function hasRwxYmlFiles(repoRoot) {
  const rwxDir = join(repoRoot, ".rwx");
  try {
    const entries = await readdir(rwxDir, { withFileTypes: true });
    return entries.some((e) => e.isFile() && e.name.endsWith(".yml"));
  } catch {
    return false;
  }
}

function trimOutput(s) {
  if (!s) return "";
  const t = String(s).trim();
  return t.length > 800_000 ? `${t.slice(0, 800_000)}\n\n… (truncated)` : t;
}

export default tool({
  name: "ci-testing",
  description:
    "Run automated tests for the current repository. If `.rwx/*.yml` exists, runs the RWX workflow `.rwx/build-and-test.yml` (no git push needed). Always run git add on all new/changed files before ci-testing. If ci-testing reports 'The patch did not include the following untracked file', the run result is invalid — stage the file and re-run. If tests fail, read the errors, fix the code, and call this tool again until tests pass (up to 3 times). If there is no RWX suite, follow CLAUDE.md (or README) for how to test and iterate until green.",
  args: {},
  async execute() {
    const repoRoot = process.cwd();

    const hasSuite = await hasRwxYmlFiles(repoRoot);
    if (!hasSuite) {
      return NO_RWX_GUIDANCE;
    }

    try {
      const { stdout, stderr } = await execFileAsync(
        "rwx",
        ["run", ".rwx/build-and-test.yml", "--wait", "--fail-fast"],
        {
          cwd: repoRoot,
          maxBuffer: 50 * 1024 * 1024,
        }
      );

      const out = trimOutput(stdout);
      const err = trimOutput(stderr);
      const parts = ["RWX build-and-test completed successfully (exit 0).", ""];
      if (out) parts.push("stdout:", out, "");
      if (err) parts.push("stderr:", err);
      return parts.filter(Boolean).join("\n");
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      const stdout = error && typeof error === "object" && "stdout" in error ? error.stdout : "";
      const stderr = error && typeof error === "object" && "stderr" in error ? error.stderr : "";

      if (code === "ENOENT") {
        return [
          "Could not run `rwx`: command not found on PATH.",
          "Ensure the sandbox image includes the RWX CLI, or run tests manually per CLAUDE.md / AGENTS.md.",
        ].join("\n");
      }

      const out = trimOutput(
        Buffer.isBuffer(stdout) ? stdout.toString("utf8") : String(stdout || "")
      );
      const err = trimOutput(
        Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr || "")
      );
      const msg =
        error instanceof Error && error.message && code !== undefined
          ? error.message
          : String(error);

      const parts = [
        `RWX build-and-test failed (exit ${code ?? "non-zero"}).`,
        "Review the output below, fix the failures, then run ci-testing again.",
        "",
      ];
      if (out) parts.push("stdout:", out, "");
      if (err) parts.push("stderr:", err, "");
      parts.push(`Process: ${msg}`);
      return parts.join("\n");
    }
  },
});
