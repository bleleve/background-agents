/**
 * CI Testing Tool — run all RWX workflow files with "test" in the name when present.
 *
 * When `.rwx/` contains files with "test" in the name, runs `rwx run <file> --wait --fail-fast`
 * for each matching file from the repo root. No git push is required. Always run `git add` on all
 * new/changed files before ci-testing. If ci-testing reports "The patch did not include the
 * following untracked file", the run result is invalid — stage the file and re-run.
 *
 * If no RWX test files exist, directs the agent to project docs for testing.
 */
import { tool } from "@opencode-ai/plugin";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

const NO_RWX_GUIDANCE = [
  'No RWX test suite in this repository: `.rwx` is missing or it contains no files with "test" in the name.',
  "",
  "Run tests using the commands documented at the repo root — typically **CLAUDE.md** or **AGENTS.md** (e.g. `npm test`, `pytest`, or the project’s stated test/lint commands).",
  "",
  "If you change code, re-run those tests until they pass. Read failure output carefully and fix the underlying issues before finishing.",
].join("\n");

async function findTestFiles(repoRoot) {
  const rwxDir = join(repoRoot, ".rwx");
  try {
    const entries = await readdir(rwxDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.includes("test"))
      .map((e) => join(".rwx", e.name));
  } catch {
    return [];
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
    "**Mandantory Tool to be used before committing any changes.** If `.rwx/` contains files with \"test\" in the name, runs each via `rwx run <file> --wait --fail-fast` (no git push needed). Always run git add on all new/changed files before ci-testing. If ci-testing reports 'The patch did not include the following untracked file', the run result is invalid — stage the file and re-run. If tests fail, read the errors, fix the code, and call this tool again until tests pass (up to 3 times). If there is no RWX suite, follow CLAUDE.md (or README) for how to test and iterate until green.",
  args: {},
  async execute() {
    const repoRoot = process.cwd();

    const testFiles = await findTestFiles(repoRoot);
    if (testFiles.length === 0) {
      return NO_RWX_GUIDANCE;
    }

    const results = [];
    for (const file of testFiles) {
      try {
        const { stdout, stderr } = await execFileAsync(
          "rwx",
          ["run", file, "--wait", "--fail-fast"],
          {
            cwd: repoRoot,
            maxBuffer: 50 * 1024 * 1024,
          }
        );

        const out = trimOutput(stdout);
        const err = trimOutput(stderr);
        const parts = [`RWX ${file} completed successfully (exit 0).`, ""];
        if (out) parts.push("stdout:", out, "");
        if (err) parts.push("stderr:", err);
        results.push(parts.filter(Boolean).join("\n"));
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
          `RWX ${file} failed (exit ${code ?? "non-zero"}).`,
          "Review the output below, fix the failures, then run ci-testing again.",
          "",
        ];
        if (out) parts.push("stdout:", out, "");
        if (err) parts.push("stderr:", err, "");
        parts.push(`Process: ${msg}`);
        return parts.join("\n");
      }
    }

    return results.join("\n\n---\n\n");
  },
});
