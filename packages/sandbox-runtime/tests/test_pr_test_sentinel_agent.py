"""The pr-test-sentinel subagent must stay mutation-free and description-driven.

It ships as a bundled .md installed flat into ~/.config/opencode/agents by
_install_agents, so its frontmatter is what makes it a read-only subagent. Unlike
pr-doc-sentinel it keeps `bash: true` (to list changed files and grep existing
tests), so the body must explicitly forbid running the suite / coverage tools —
the review sandbox is on the default branch, not the PR head.
"""

from pathlib import Path

AGENT_FILE = (
    Path(__file__).resolve().parent.parent
    / "src"
    / "sandbox_runtime"
    / "agents"
    / "pr-test-sentinel.md"
)


def _read() -> str:
    return AGENT_FILE.read_text()


def _frontmatter() -> str:
    text = _read()
    assert text.startswith("---\n"), "frontmatter must open the file"
    end = text.index("\n---", 4)
    return text[4:end]


def test_agent_file_exists() -> None:
    assert AGENT_FILE.is_file()


def test_is_mutation_free_subagent() -> None:
    fm = _frontmatter()
    assert "mode: subagent" in fm
    # It must never edit the repo or post; it only returns findings to the caller.
    assert "write: false" in fm
    assert "edit: false" in fm


def test_has_description_for_description_driven_invocation() -> None:
    fm = _frontmatter()
    assert "description:" in fm
    # The description must mention tests/coverage so the primary agent knows when to invoke it.
    assert "test" in fm.lower() or "coverage" in fm.lower()


def test_forbids_running_the_suite() -> None:
    # bash is enabled, so the body must hard-forbid running tests/coverage/build —
    # static diff analysis only (the worktree is the default branch, not the PR head).
    body = _read()
    assert "Do NOT run the test suite" in body


def test_defaults_to_silence_on_non_test_worthy_changes() -> None:
    # Martin's framing: most PRs are not test-worthy and must produce no alert.
    body = _read()
    assert "No test-worthy changes." in body
    assert "default is **silence**" in body
