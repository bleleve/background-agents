import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REEF_RISK_MARKER_RE, REEF_VERDICT_MARKER } from "../src/prompts";

// The mechanical "how to post" procedures were lifted out of the github-bot prompt
// (prompts.ts) into OpenCode skills bundled in the sandbox image, so the ~4KB of
// step-by-step gh api instructions load on demand instead of shipping in every review
// prompt. These tests pin the moved content to the skill files and, crucially, guard
// the CROSS-PACKAGE contract: the hidden markers the skills emit must still match the
// regexes/constants the github-bot webhook path parses (prompts.ts). A skill living in
// a different package/deploy cadence makes this drift silent otherwise.
const skillsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../sandbox-runtime/src/sandbox_runtime/skills"
);

function readSkill(name: string): string {
  return readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
}

describe("reef-inline-suggestion skill", () => {
  const skill = readSkill("reef-inline-suggestion");

  it("advertises itself with name + description frontmatter", () => {
    expect(skill).toContain("name: reef-inline-suggestion");
    expect(skill.toLowerCase()).toContain("description:");
  });

  it("carries the mechanical posting steps lifted out of the prompt", () => {
    // gh api POST to the pulls/comments endpoint (PR-agnostic placeholders)
    expect(skill).toContain('gh api -X POST "repos/<owner>/<repo>/pulls/<pr-number>/comments"');
    // head SHA fetch, heredoc body, applyable suggestion fence, multi-line anchors
    expect(skill).toContain("--json headRefOid --jq .headRefOid");
    expect(skill).toContain("cat >/tmp/pr-suggestion.md");
    expect(skill).toContain("```suggestion");
    expect(skill).toContain("-F start_line=");
    expect(skill).toContain('-f side="RIGHT"');
    expect(skill).toContain('-f start_side="RIGHT"');
    // post-hoc read-back that confirms the Apply button, and the mis-anchor DELETE.
    // `Apply suggestion` is prose (markdown proseWrap can break it across a line), so
    // match it whitespace-tolerantly rather than as a literal contiguous substring.
    expect(skill).toContain("Verify the anchor");
    expect(skill).toMatch(/Apply\s+suggestion/);
    expect(skill).toContain('gh api -X DELETE "repos/<owner>/<repo>/pulls/comments/$COMMENT_ID"');
  });

  it("emits a reef-risk marker line the webhook regex can parse (cross-package contract)", () => {
    // The skill writes the hidden severity marker; the github-bot webhook extracts it
    // with REEF_RISK_MARKER_RE (prompts.ts). If the skill's marker format drifts, the
    // "by risk" analytics silently bucket to unknown — assert the contract holds.
    expect(skill).toMatch(REEF_RISK_MARKER_RE);
    expect("<!-- reef-risk: high -->").toMatch(REEF_RISK_MARKER_RE);
  });

  it("does not duplicate the eligibility gate (that stays inline in the prompt)", () => {
    // The gate is judgment the agent needs before forming a finding, so it lives in the
    // prompt, not the skill. Keeping it out of the skill avoids two sources of truth.
    expect(skill).not.toContain("ELIGIBILITY GATE");
  });
});

describe("reef-verdict skill", () => {
  const skill = readSkill("reef-verdict");

  it("advertises itself with name + description frontmatter", () => {
    expect(skill).toContain("name: reef-verdict");
    expect(skill.toLowerCase()).toContain("description:");
  });

  it("renders the body and posts via the submit-review-verdict tool (no client label sync)", () => {
    // Renders the risk-map template to a temp file, passed to the tool.
    expect(skill).toContain("cat >/tmp/pr-verdict.md");
    // Posts via the tool — delete-then-post AND the label sync now happen server-side.
    expect(skill).toContain("submit-review-verdict");
    // The old client-side gh label shell moved to the control plane (pr-verdict.ts)
    // and must NOT remain in the skill.
    expect(skill).not.toContain("gh label create");
    expect(skill).not.toContain("--add-label");
  });

  it("does not post the verdict with raw gh (that path is blocked in review sessions)", () => {
    // The verdict is the one conversation comment a review posts; it must go through the
    // tool, so the skill must NOT tell the agent to POST it with raw gh api / gh pr comment.
    expect(skill).not.toContain(
      'gh api -X POST "repos/<owner>/<repo>/issues/<pr-number>/comments"'
    );
    expect(skill).not.toContain("gh api --paginate");
  });

  it("begins the verdict body with the marker the webhook fallback searches for (cross-package contract)", () => {
    // github-bot's /callbacks/complete fallback and the re-review dedup find a prior verdict
    // by this exact marker (REEF_VERDICT_MARKER in prompts.ts). If the skill's marker drifts,
    // the fallback double-posts and re-reviews stop replacing the old verdict.
    expect(skill).toContain(REEF_VERDICT_MARKER);
  });
});
