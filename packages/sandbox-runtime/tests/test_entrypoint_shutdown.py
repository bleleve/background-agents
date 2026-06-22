import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.entrypoint import SandboxSupervisor


@pytest.fixture
def supervisor():
    with patch.dict("os.environ", {}, clear=False):
        return SandboxSupervisor()


class TestTerminateChild:
    """Unit tests for the subprocess shutdown helper."""

    @pytest.mark.asyncio
    async def test_terminate_child_waits_for_exit(self, supervisor):
        process = MagicMock()
        process.returncode = None
        process.terminate = MagicMock()
        process.wait = AsyncMock(return_value=None)
        process.kill = MagicMock()

        await supervisor._terminate_child(process, timeout_seconds=5.0, name="test")

        process.terminate.assert_called_once()
        process.wait.assert_awaited_once()
        process.kill.assert_not_called()

    @pytest.mark.asyncio
    async def test_terminate_child_kills_and_reaps_on_timeout(self, supervisor):
        process = MagicMock()
        process.returncode = None
        process.terminate = MagicMock()
        process.wait = AsyncMock(side_effect=TimeoutError)
        process.kill = MagicMock()

        await supervisor._terminate_child(process, timeout_seconds=0.1, name="test")

        process.terminate.assert_called_once()
        assert process.wait.await_count == 2
        process.kill.assert_called_once()

    @pytest.mark.asyncio
    async def test_terminate_child_noop_when_already_exited(self, supervisor):
        process = MagicMock()
        process.returncode = 0
        process.terminate = MagicMock()
        process.kill = MagicMock()

        await supervisor._terminate_child(process, timeout_seconds=5.0, name="test")

        process.terminate.assert_not_called()
        process.kill.assert_not_called()


class TestCancelLogTask:
    """Unit tests for log-forwarding task cancellation."""

    @pytest.mark.asyncio
    async def test_cancel_log_task_cancels_running_task(self, supervisor):
        async def never_ends():
            while True:
                await supervisor.shutdown_event.wait()

        task = asyncio.create_task(never_ends())
        assert not task.done()

        await supervisor._cancel_log_task(task, name="test")

        assert task.cancelled()

    @pytest.mark.asyncio
    async def test_cancel_log_task_noop_for_done_task(self, supervisor):
        async def done_immediately():
            return

        task = asyncio.create_task(done_immediately())
        await task

        await supervisor._cancel_log_task(task, name="test")

        assert task.done()
        assert not task.cancelled()
