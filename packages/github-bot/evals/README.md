# Reviewer eval set

A small, growing set of real-incident-shaped cases (`diff` in → `expectedFinding` out) used to guard
against PR-reviewer prompt regressions — specifically, changes that stop surfacing a known issue or
that start adding noise.

## Layout

- `cases/*.json` — one curated case each: the PR metadata, the `diff`, and the `expectedFinding`
  (file + one-line summary of the issue a good review must raise).
- `replay.ts` — **manual, non-gating.** Prints, per case, the assembled review prompt + diff +
  expected finding for human inspection. Run with `npx tsx packages/github-bot/evals/replay.ts`.

## What is automated vs. manual

- **Automated (CI):** `../test/evals.test.ts` asserts that every case builds a well-formed review
  prompt carrying the guardrails (disprove-it pass, verdict marker, blind-spot axes). This is
  deterministic and runs with the normal `npm test -w @open-inspect/github-bot`.
- **Manual:** judging whether the model actually flags `expectedFinding` requires a live model and a
  sandbox. `replay.ts` sets up the inputs; wiring it to a model + automatic grading is future work.

## Adding a case

Drop a new `cases/<name>.json` with the same shape. Prefer real incidents the reviewer missed or got
wrong, and write `expectedFinding.summary` as the concrete behavioral risk (not "looks off").
