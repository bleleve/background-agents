import { describe, it, expect } from "vitest";
import { enforceVerdictFloor } from "./verdict-floor";

describe("enforceVerdictFloor", () => {
  // The verdict that motivated this guard: a 🔵 Low header over two 🟡 Tests
  // coverage gaps, with a self-contradictory "raised to 🔵 Low" summary.
  // https://github.com/onboardiq/background-agents/pull/68
  const pr68 = [
    "<!-- reef-verdict -->",
    "## 🔵 Reef Review — Low risk",
    "",
    "### Summary",
    "> Clean, well-tested pure resolver; only minor coverage gaps remain.",
    "",
    "**No correctness findings** — risk raised to 🔵 Low by two small test gaps (see Tests coverage).",
    "",
    "### Tests coverage",
    "🧪 2 test-worthy change(s) without a test",
    "- 🟡 `packages/shared/src/preambles/resolver.ts:26` — undefined branch never exercised",
    "- 🟡 `packages/shared/src/preambles/resolver.ts:28` — empty-array path untested",
    "",
    "### Docs drift",
    "- 📝 `packages/shared/src/preambles/types.ts` — aspirational docstring",
    "",
    "<details>",
    "<summary>Reviewed, no concerns</summary>",
    "",
    "- **Correctness** — all five matcher branches are correct",
    "</details>",
  ].join("\n");

  it("raises the header to the highest coverage gap and fixes the summary (PR #68)", () => {
    const { body, changed, from, to } = enforceVerdictFloor(pr68);

    expect(changed).toBe(true);
    expect(from).toBe("🔵 Low");
    expect(to).toBe("🟡 Medium");

    // Header badge is floored to Medium.
    expect(body).toContain("## 🟡 Reef Review — Medium risk");
    expect(body).not.toContain("## 🔵 Reef Review — Low risk");

    // The contradictory summary line is corrected to match.
    expect(body).toContain("risk raised to 🟡 Medium by two small test gaps");
    expect(body).not.toContain("risk raised to 🔵 Low");

    // Untouched: the already-🟡 gap bullets, docs drift, reviewed notes.
    expect(body).toContain("- 🟡 `packages/shared/src/preambles/resolver.ts:26`");
    expect(body).toContain("- 📝 `packages/shared/src/preambles/types.ts`");
    expect(body).toContain("- **Correctness** — all five matcher branches are correct");
  });

  it("is idempotent — a second pass changes nothing", () => {
    const once = enforceVerdictFloor(pr68).body;
    const twice = enforceVerdictFloor(once);
    expect(twice.changed).toBe(false);
    expect(twice.body).toBe(once);
  });

  it("floors the header to a 🔴 Worth-a-look finding (not just coverage)", () => {
    const body = [
      "<!-- reef-verdict -->",
      "## 🔵 Reef Review — Low risk",
      "",
      "### Worth a look",
      "- 🔴 `x.ts:5` — null deref crashes the worker → [inline](https://example/1)",
      "- 🟡 `y.ts:9` — smaller issue → [inline](https://example/2)",
    ].join("\n");

    const res = enforceVerdictFloor(body);
    expect(res.changed).toBe(true);
    expect(res.to).toBe("🔴 High");
    expect(res.body).toContain("## 🔴 Reef Review — High risk");
  });

  it("raises the header to a 🟡 Worth-a-look finding with no coverage section", () => {
    const body = [
      "<!-- reef-verdict -->",
      "## 🔵 Reef Review — Low risk",
      "",
      "### Worth a look",
      "- 🟡 `a.ts:3` — off-by-one → [inline](https://example/1)",
    ].join("\n");

    const res = enforceVerdictFloor(body);
    expect(res.changed).toBe(true);
    expect(res.body).toContain("## 🟡 Reef Review — Medium risk");
  });

  it("lifts a 🔵 Tests-coverage bullet to 🟡 and floors the header", () => {
    const body = [
      "<!-- reef-verdict -->",
      "## 🔵 Reef Review — Low risk",
      "",
      "### Tests coverage",
      "🧪 1 test-worthy change(s) without a test",
      "- 🔵 `foo.ts:1` — untested branch",
    ].join("\n");

    const res = enforceVerdictFloor(body);
    expect(res.changed).toBe(true);
    expect(res.body).toContain("- 🟡 `foo.ts:1` — untested branch");
    expect(res.body).not.toContain("- 🔵 `foo.ts:1`");
    expect(res.body).toContain("## 🟡 Reef Review — Medium risk");
  });

  it("never lowers a header that is already above its findings", () => {
    const body = [
      "<!-- reef-verdict -->",
      "## 🔴 Reef Review — High risk",
      "",
      "### Tests coverage",
      "🧪 1 test-worthy change(s) without a test",
      "- 🟡 `x.ts:2` — gap",
    ].join("\n");

    const res = enforceVerdictFloor(body);
    expect(res.changed).toBe(false);
    expect(res.body).toBe(body);
  });

  it("leaves a clean no-findings verdict untouched", () => {
    const body = [
      "<!-- reef-verdict -->",
      "## 🔵 Reef Review — Low risk",
      "",
      "### Summary",
      "> Nothing to flag.",
      "",
      "**No findings.**",
      "",
      "<details>",
      "<summary>Reviewed, no concerns</summary>",
      "",
      "- **Correctness** — verified the happy path",
      "</details>",
    ].join("\n");

    const res = enforceVerdictFloor(body);
    expect(res.changed).toBe(false);
    expect(res.body).toBe(body);
  });

  it("does not treat the severity legend as a finding bullet", () => {
    const body = [
      "<!-- reef-verdict -->",
      "## 🔵 Reef Review — Low risk",
      "Badge: 🔵 low · 🟡 medium · 🔴 high",
      "",
      "**No findings.**",
    ].join("\n");

    const res = enforceVerdictFloor(body);
    expect(res.changed).toBe(false);
    expect(res.body).toBe(body);
  });

  it("ignores docs-drift and reviewed bullets when flooring", () => {
    const body = [
      "<!-- reef-verdict -->",
      "## 🔵 Reef Review — Low risk",
      "",
      "### Docs drift",
      "- 📝 `README.md` — stale flag name",
      "",
      "<details>",
      "<summary>Reviewed, no concerns</summary>",
      "",
      "- **API surface** — unchanged",
      "</details>",
    ].join("\n");

    const res = enforceVerdictFloor(body);
    expect(res.changed).toBe(false);
    expect(res.body).toBe(body);
  });

  it("returns a body with no recognizable verdict header untouched", () => {
    const body = "just some text\n- 🔴 not a verdict bullet";
    const res = enforceVerdictFloor(body);
    expect(res.changed).toBe(false);
    expect(res.body).toBe(body);
  });
});
