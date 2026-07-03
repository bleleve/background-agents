/**
 * Deterministic coverage-floor enforcement for the Reef review verdict comment.
 *
 * The verdict badge is model-authored. The github-bot review prompt couples the
 * header badge to the findings by *instruction* only ("the header is never lower
 * than the highest severity shown in any section below"; a Tests coverage gap is
 * at least 🟡 Medium). Instructions drift: an LLM occasionally posts a 🔵 Low
 * header sitting above 🟡/🔴 finding bullets, with a self-contradictory summary
 * ("risk raised to 🔵 Low by two small test gaps"). Observed live on
 * onboardiq/background-agents#68.
 *
 * This makes the invariant deterministic at the one server-side choke point that
 * posts the comment, so a verdict can never contradict its own findings
 * regardless of model adherence. It is raise-only — a correct verdict passes
 * through byte-for-byte unchanged.
 *
 * Rules enforced:
 *   1. Every bullet inside the `### Tests coverage` section is at least 🟡 — a
 *      🔵 coverage bullet is lifted to 🟡 (a genuine must-test gap is never Low;
 *      a change that would rate only Low is trivial plumbing the sentinel should
 *      not have listed).
 *   2. The header badge is at least the highest-severity finding bullet anywhere
 *      (Worth a look OR Tests coverage).
 *   3. A "risk raised to <badge>" summary phrase is corrected to the enforced
 *      badge so the prose cannot contradict the header.
 *
 * The `level` this returns also drives the PR risk LABEL: `syncRiskLabel` in
 * pr-verdict.ts sets `reef: <level> risk` server-side from this same enforced
 * badge, so the label can never drift from the comment (the `reef-verdict` skill
 * no longer touches it).
 */

type Severity = "🔵" | "🟡" | "🔴";

const RANK: Record<Severity, number> = { "🔵": 1, "🟡": 2, "🔴": 3 };
const BADGE: Record<number, { emoji: Severity; word: string }> = {
  1: { emoji: "🔵", word: "Low" },
  2: { emoji: "🟡", word: "Medium" },
  3: { emoji: "🔴", word: "High" },
};

/** The risk level a badge maps to — also the suffix of the `reef: <level> risk` PR label. */
export type RiskLevel = "low" | "medium" | "high";
const LEVEL_BY_RANK: Record<number, RiskLevel> = { 1: "low", 2: "medium", 3: "high" };

/** The verdict header, e.g. `## 🟡 Reef Review — Medium risk`. */
const HEADER_RE = /^(#{1,6}\s*)(🔵|🟡|🔴)(\s*Reef Review\s*—\s*)(Low|Medium|High)(\s*risk\b.*)$/;
/** A markdown list item whose badge is a severity emoji (a finding bullet). */
const FINDING_BULLET_RE = /^\s*[-*]\s*(🔵|🟡|🔴)/;
/** The `### Tests coverage` heading. */
const TESTS_COVERAGE_HEADING_RE = /^#{1,6}\s*Tests coverage\b/i;
/** The headings whose bullets are findings that floor the badge. */
const FINDING_SECTION_HEADING_RE = /^#{1,6}\s*(Worth a look|Tests coverage)\b/i;
/** Any heading — marks the end of a section. */
const HEADING_RE = /^#{1,6}\s/;
/** A `risk raised to <emoji> <Level>` phrase in the summary. */
const RAISED_BADGE_RE = /(raised[^\n]*?)(🔵|🟡|🔴)(\s+)(Low|Medium|High)/i;

export interface FloorResult {
  /** The enforced body (identical to the input when nothing needed changing). */
  body: string;
  /** True when enforcement rewrote anything. */
  changed: boolean;
  /** Header badge before the raise, e.g. `🔵 Low` (set only when the header moved). */
  from?: string;
  /** Header badge after the raise, e.g. `🟡 Medium` (set only when the header moved). */
  to?: string;
  /**
   * The final (post-enforcement) risk level, for syncing the `reef: <level> risk`
   * PR label from the same authoritative badge. Undefined when the body has no
   * recognizable verdict header.
   */
  level?: RiskLevel;
}

/**
 * Raise the verdict header badge (and fix a contradictory summary line) so it is
 * never below the highest-severity finding it lists, and lift any Low bullet in
 * the Tests coverage section to Medium. Never lowers a badge; returns the body
 * unchanged when it is already consistent or is not a recognizable verdict.
 */
export function enforceVerdictFloor(body: string): FloorResult {
  const lines = body.split("\n");

  const headerIdx = lines.findIndex((l) => HEADER_RE.test(l));
  // Not a recognizable verdict header — leave it entirely alone.
  if (headerIdx === -1) return { body, changed: false };

  const headerEmoji = lines[headerIdx].match(HEADER_RE)![2] as Severity;
  let headerRank = RANK[headerEmoji];

  // Pass 1 — within the Tests coverage section, lift 🔵 finding bullets to 🟡.
  const covStart = lines.findIndex((l) => TESTS_COVERAGE_HEADING_RE.test(l));
  if (covStart !== -1) {
    for (let i = covStart + 1; i < lines.length; i++) {
      const line = lines[i];
      if (HEADING_RE.test(line) || /^\s*<details/i.test(line)) break;
      if (/^\s*[-*]\s*🔵/.test(line)) lines[i] = line.replace("🔵", "🟡");
    }
  }

  // Pass 2 — highest-severity finding bullet within the finding sections only
  // (Worth a look / Tests coverage), after the lift above. Docs drift, the
  // Reviewed <details>, and any prose emoji must not floor the badge — a
  // model-authored 🟡/🔴 outside a findings section is not a finding.
  let maxBulletRank = 0;
  let inFindingSection = false;
  for (const line of lines) {
    if (HEADING_RE.test(line)) {
      inFindingSection = FINDING_SECTION_HEADING_RE.test(line);
      continue;
    }
    if (/^\s*<details/i.test(line)) {
      inFindingSection = false;
      continue;
    }
    if (!inFindingSection) continue;
    const m = line.match(FINDING_BULLET_RE);
    if (m) maxBulletRank = Math.max(maxBulletRank, RANK[m[1] as Severity]);
  }

  // Raise the header to the floor (never lower it).
  let from: string | undefined;
  let to: string | undefined;
  const enforcedRank = Math.max(headerRank, maxBulletRank);
  if (enforcedRank > headerRank) {
    const badge = BADGE[enforcedRank];
    from = `${BADGE[headerRank].emoji} ${BADGE[headerRank].word}`;
    to = `${badge.emoji} ${badge.word}`;
    lines[headerIdx] = lines[headerIdx].replace(
      HEADER_RE,
      (_full, h1, _emoji, mid, _word, tail) => `${h1}${badge.emoji}${mid}${badge.word}${tail}`
    );
    headerRank = enforcedRank;
  }

  let result = lines.join("\n");

  // Pass 3 — a "risk raised to <badge>" summary phrase must not undercut the header.
  const raised = result.match(RAISED_BADGE_RE);
  if (raised && RANK[raised[2] as Severity] < headerRank) {
    const badge = BADGE[headerRank];
    result = result.replace(
      RAISED_BADGE_RE,
      (_full, pre, _emoji, space, _word) => `${pre}${badge.emoji}${space}${badge.word}`
    );
  }

  return { body: result, changed: result !== body, from, to, level: LEVEL_BY_RANK[headerRank] };
}
