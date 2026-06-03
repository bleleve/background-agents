/**
 * Reviewer eval replay — manual, NON-gating.
 *
 * Loads the curated cases in ./cases and prints, for each, the review prompt the
 * bot would send plus the diff and the expected finding. This lets a human eyeball
 * whether a prompt change still surfaces a known issue without adding noise.
 *
 * Judging the model's actual output is not done here (it requires a live model and
 * a sandbox); that grading harness is future work. The deterministic, CI-gating
 * part of the eval set lives in ../test/evals.test.ts.
 *
 * Run:  npx tsx packages/github-bot/evals/replay.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodeReviewPrompt } from "../src/prompts";

interface EvalCase {
  name: string;
  description: string;
  pr: Parameters<typeof buildCodeReviewPrompt>[0];
  diff: string;
  expectedFinding: { file: string; summary: string };
}

function loadCases(): EvalCase[] {
  const casesDir = join(dirname(fileURLToPath(import.meta.url)), "cases");
  return readdirSync(casesDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(casesDir, f), "utf8")) as EvalCase);
}

function main(): void {
  const cases = loadCases();
  console.log(`Loaded ${cases.length} reviewer eval case(s).\n`);

  for (const c of cases) {
    const prompt = buildCodeReviewPrompt(c.pr);
    console.log("═".repeat(80));
    console.log(`CASE: ${c.name}`);
    console.log(c.description);
    console.log(`\nEXPECTED FINDING (${c.expectedFinding.file}):\n  ${c.expectedFinding.summary}`);
    console.log(`\nDIFF:\n${c.diff}`);
    console.log(`\nREVIEW PROMPT (${prompt.length} chars):\n${prompt}\n`);
  }
}

main();
