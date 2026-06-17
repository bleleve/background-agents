"""Regression test: start_opencode must run its synchronous install steps off
the asyncio event loop (via asyncio.to_thread).

The supervisor starts a concurrent _boot_progress_loop that pings the control
plane during boot. _install_tools (notably its shutil.copytree of the OpenCode
node_modules) and the other _install_* steps are blocking synchronous I/O; if
they run directly on the event loop they freeze the ping loop, and a
healthy-but-slow boot gets marked stale by the 90s heartbeat watchdog. This test
pins the fix: those steps must be dispatched through asyncio.to_thread.
"""

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.entrypoint import SandboxSupervisor


def _make_supervisor() -> SandboxSupervisor:
    with patch.dict(
        "os.environ",
        {
            "SANDBOX_ID": "test-sandbox",
            "CONTROL_PLANE_URL": "https://cp.example.com",
            "SANDBOX_AUTH_TOKEN": "tok",
            "REPO_OWNER": "acme",
            "REPO_NAME": "app",
        },
    ):
        return SandboxSupervisor()


@pytest.mark.asyncio
async def test_start_opencode_offloads_sync_install_to_threads(tmp_path: Path):
    sup = _make_supervisor()
    sup.workspace_path = tmp_path
    sup.repo_path = tmp_path / "no-repo"  # absent -> workdir = workspace_path

    # Stub everything start_opencode touches except the install dispatch.
    sup._setup_openai_oauth = MagicMock()
    sup._configure_langfuse = MagicMock()
    sup._resolve_mcp_servers = MagicMock(return_value=[])
    sup._forward_opencode_logs = AsyncMock()
    sup._wait_for_health = AsyncMock()

    # The synchronous install steps we expect to be offloaded.
    sup._install_tools = MagicMock()
    sup._install_skills = MagicMock()
    sup._install_agents = MagicMock()
    sup._install_bin_scripts = MagicMock()
    sup._deploy_opencode_plugins = MagicMock()

    offloaded: list = []

    async def recording_to_thread(func, *args, **kwargs):
        offloaded.append(func)
        return func(*args, **kwargs)

    with (
        patch(
            "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
            AsyncMock(return_value=MagicMock()),
        ),
        patch("sandbox_runtime.entrypoint.asyncio.to_thread", side_effect=recording_to_thread),
    ):
        await sup.start_opencode()

    # Every blocking install step must have gone through asyncio.to_thread,
    # never been called directly on the event loop.
    for installer in (
        sup._install_tools,
        sup._install_skills,
        sup._install_agents,
        sup._install_bin_scripts,
        sup._deploy_opencode_plugins,
    ):
        assert installer in offloaded, f"{installer} was not offloaded via asyncio.to_thread"
        installer.assert_called_once()
