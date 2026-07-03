from pathlib import Path

from sandbox_runtime.bridge import AgentBridge


def _create_bridge(tmp_path: Path) -> AgentBridge:
    bridge = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )
    bridge.repo_path = tmp_path
    return bridge


def _write_skill(repo_dir: Path) -> None:
    skill = repo_dir / ".claude" / "skills" / "detect-app" / "SKILL.md"
    skill.parent.mkdir(parents=True, exist_ok=True)
    skill.write_text("---\nname: detect-app\ndescription: x\n---\n")


def test_no_block_when_no_repository(tmp_path: Path):
    bridge = _create_bridge(tmp_path)
    # No .git anywhere → _resolve_repo_dir() is None.
    assert bridge._build_app_targeting_context() is None


def test_no_block_when_repo_lacks_skill(tmp_path: Path):
    bridge = _create_bridge(tmp_path)
    (tmp_path / ".git").mkdir()
    assert bridge._build_app_targeting_context() is None


def test_block_when_repo_ships_skill(tmp_path: Path):
    bridge = _create_bridge(tmp_path)
    (tmp_path / ".git").mkdir()
    _write_skill(tmp_path)

    block = bridge._build_app_targeting_context()

    assert block is not None
    assert block.startswith("<app_targeting>")
    assert block.rstrip().endswith("</app_targeting>")
    assert "detect-app" in block


def test_block_when_skill_in_child_workspace_repo(tmp_path: Path):
    bridge = _create_bridge(tmp_path)
    repo_dir = tmp_path / "megalith"
    (repo_dir / ".git").mkdir(parents=True)
    _write_skill(repo_dir)

    block = bridge._build_app_targeting_context()

    assert block is not None
    assert "<app_targeting>" in block


def test_missing_skill_directory_is_silent(tmp_path: Path):
    bridge = _create_bridge(tmp_path)
    (tmp_path / ".git").mkdir()
    # A partial path (dir without SKILL.md) must not count as present.
    (tmp_path / ".claude" / "skills" / "detect-app").mkdir(parents=True)
    assert bridge._build_app_targeting_context() is None
