import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodeReviewPrompt, REEF_VERDICT_MARKER } from "../src/prompts";

interface EvalCase {
  name: string;
  description: string;
  pr: Parameters<typeof buildCodeReviewPrompt>[0];
  diff: string;
  expectedFinding: { file: string; summary: string };
}

const casesDir = join(dirname(fileURLToPath(import.meta.url)), "../evals/cases");
const cases: EvalCase[] = readdirSync(casesDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(casesDir, f), "utf8")) as EvalCase);

describe("reviewer eval fixtures", () => {
  it("has at least one curated case", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    describe(c.name, () => {
      it("builds a well-formed review prompt carrying the guardrails", () => {
        const prompt = buildCodeReviewPrompt(c.pr);
        expect(prompt).toContain(`Pull Request #${c.pr.number} in ${c.pr.owner}/${c.pr.repo}`);
        // Precision guardrails introduced by workstreams A + E must remain present.
        expect(prompt).toContain("Disprove it before posting");
        expect(prompt).toContain("Don't flag what the repo's own tooling already catches");
        expect(prompt).toContain(REEF_VERDICT_MARKER);
      });

      it("declares a concrete expected finding", () => {
        expect(typeof c.expectedFinding.file).toBe("string");
        expect(c.expectedFinding.file.length).toBeGreaterThan(0);
        expect(c.expectedFinding.summary.length).toBeGreaterThan(0);
        // The expected finding should point at a file touched by the diff.
        expect(c.diff).toContain(c.expectedFinding.file);
      });
    });
  }
});
