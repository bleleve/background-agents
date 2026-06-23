import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

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


def _fake_process(returncode: int, stdout: bytes):
    process = MagicMock()
    process.returncode = returncode
    process.communicate = AsyncMock(return_value=(stdout, b""))
    return process


@pytest.mark.asyncio
async def test_get_head_sha_reads_child_workspace_repo(tmp_path: Path):
    bridge = _create_bridge(tmp_path)
    repo_dir = tmp_path / "background-agents"
    (repo_dir / ".git").mkdir(parents=True)
    sha = "a" * 40

    with patch(
        "sandbox_runtime.bridge.asyncio.create_subprocess_exec",
        AsyncMock(return_value=_fake_process(0, f"{sha}\n".encode())),
    ) as mock_exec:
        result = await bridge._get_head_sha()

    assert result == sha
    mock_exec.assert_awaited_once_with(
        "git",
        "-C",
        str(repo_dir),
        "rev-parse",
        "HEAD",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )


@pytest.mark.asyncio
async def test_get_head_sha_reads_repo_path_when_it_is_the_repo(tmp_path: Path):
    bridge = _create_bridge(tmp_path)
    (tmp_path / ".git").mkdir()
    sha = "b" * 40

    with patch(
        "sandbox_runtime.bridge.asyncio.create_subprocess_exec",
        AsyncMock(return_value=_fake_process(0, f"{sha}\n".encode())),
    ):
        result = await bridge._get_head_sha()

    assert result == sha


@pytest.mark.asyncio
async def test_get_head_sha_returns_none_without_repo(tmp_path: Path):
    bridge = _create_bridge(tmp_path)

    with patch(
        "sandbox_runtime.bridge.asyncio.create_subprocess_exec",
        AsyncMock(),
    ) as mock_exec:
        result = await bridge._get_head_sha()

    assert result is None
    mock_exec.assert_not_awaited()
