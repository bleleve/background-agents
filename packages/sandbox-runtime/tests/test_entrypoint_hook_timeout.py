"""Regression test: _run_hook must not hang after timeout.

Scenario: start.sh spawns a background process (e.g. a dev server) that
inherits the stdout pipe's write fd and keeps running after bash exits or is
killed.  Before the fix, process.stdout.read() in the TimeoutError handler
blocked indefinitely because orphaned children held the write end open.
"""

import asyncio
from pathlib import Path
from unittest.mock import patch

import pytest

from sandbox_runtime.entrypoint import SandboxSupervisor


def _make_supervisor(tmp_path: Path) -> SandboxSupervisor:
    base_env = {
        "SANDBOX_ID": "test-sandbox",
        "CONTROL_PLANE_URL": "",
        "SANDBOX_AUTH_TOKEN": "",
        "REPO_OWNER": "acme",
        "REPO_NAME": "app",
    }
    with patch.dict("os.environ", base_env, clear=True):
        sup = SandboxSupervisor()
    sup.repo_path = tmp_path / "repo"
    sup.repo_path.mkdir()
    sup.boot_mode = "fresh"
    return sup


class TestRunHookTimeout:
    @pytest.mark.asyncio
    async def test_returns_false_and_does_not_hang_when_script_spawns_background_child(
        self, tmp_path
    ):
        """_run_hook must complete promptly even when start.sh leaves a child alive.

        The script sleeps in the foreground for longer than the timeout and also
        spawns a background sleep that outlives bash. The fix (start_new_session +
        killpg) ensures the whole process group is killed and the supervisor does
        not block on process.stdout.read().
        """
        sup = _make_supervisor(tmp_path)

        script = sup.repo_path / "scripts" / ".openinspect" / "start.sh"
        script.parent.mkdir(parents=True)
        # Spawn a long-lived background child, then sleep past the timeout.
        # The background child keeps stdout's write fd open, which would have
        # caused process.stdout.read() to block before the fix.
        script.write_text("#!/bin/bash\nsleep 300 &\nsleep 300\n")
        script.chmod(0o755)

        result = await asyncio.wait_for(
            sup._run_hook(
                hook_name="start",
                relative_script_path="scripts/.openinspect/start.sh",
                timeout_env_var="START_TIMEOUT_SECONDS",
                default_timeout_seconds=1,
            ),
            timeout=10,  # generous outer guard; the hook timeout itself is 1s
        )

        assert result is False

    @pytest.mark.asyncio
    async def test_returns_true_for_fast_script(self, tmp_path):
        sup = _make_supervisor(tmp_path)

        script = sup.repo_path / "scripts" / ".openinspect" / "start.sh"
        script.parent.mkdir(parents=True)
        script.write_text("#!/bin/bash\necho done\n")
        script.chmod(0o755)

        result = await sup._run_hook(
            hook_name="start",
            relative_script_path="scripts/.openinspect/start.sh",
            timeout_env_var="START_TIMEOUT_SECONDS",
            default_timeout_seconds=10,
        )

        assert result is True
