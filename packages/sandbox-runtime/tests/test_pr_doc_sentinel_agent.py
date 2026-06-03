"""The pr-doc-sentinel subagent must stay read-only and description-driven.

It ships as a bundled .md installed flat into ~/.config/opencode/agents by
_install_agents, so its frontmatter is what makes it a read-only subagent.
"""

from pathlib import Path

AGENT_FILE = (
    Path(__file__).resolve().parent.parent
    / "src"
    / "sandbox_runtime"
    / "agents"
    / "pr-doc-sentinel.md"
)


def _frontmatter() -> str:
    text = AGENT_FILE.read_text()
    assert text.startswith("---\n"), "frontmatter must open the file"
    end = text.index("\n---", 4)
    return text[4:end]


def test_agent_file_exists() -> None:
    assert AGENT_FILE.is_file()


def test_is_read_only_subagent() -> None:
    fm = _frontmatter()
    assert "mode: subagent" in fm
    assert "write: false" in fm
    assert "edit: false" in fm
    assert "bash: false" in fm


def test_has_description_for_description_driven_invocation() -> None:
    fm = _frontmatter()
    assert "description:" in fm
    # The description should mention documentation so the primary agent knows when to invoke it.
    assert "documentation" in fm.lower() or "docs" in fm.lower()
