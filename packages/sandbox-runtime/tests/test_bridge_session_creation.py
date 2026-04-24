"""Tests for OpenCode session creation behavior in AgentBridge."""

from unittest.mock import AsyncMock

import httpx
import pytest

from sandbox_runtime.bridge import AgentBridge
from tests.conftest import MockResponse


@pytest.mark.asyncio
async def test_create_opencode_session_uses_extended_timeout() -> None:
    bridge = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )
    bridge.http_client = AsyncMock()
    bridge.http_client.post.return_value = MockResponse(200, {"id": "ses_123"})
    bridge._save_session_id = AsyncMock()

    await bridge._create_opencode_session()

    bridge.http_client.post.assert_awaited_once_with(
        "http://localhost:4096/session",
        json={},
        timeout=bridge.OPENCODE_SESSION_CREATE_TIMEOUT_SECONDS,
    )
    assert bridge.opencode_session_id == "ses_123"


@pytest.mark.asyncio
async def test_create_opencode_session_retries_on_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    bridge = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )
    bridge.http_client = AsyncMock()
    bridge.http_client.post.side_effect = [
        httpx.ReadTimeout("timed out"),
        MockResponse(200, {"id": "ses_456"}),
    ]
    bridge._save_session_id = AsyncMock()

    sleep_mock = AsyncMock()
    monkeypatch.setattr("sandbox_runtime.bridge.asyncio.sleep", sleep_mock)

    await bridge._create_opencode_session()

    assert bridge.http_client.post.await_count == 2
    sleep_mock.assert_awaited_once_with(bridge.HTTP_RETRY_BACKOFF_SECONDS)
    assert bridge.opencode_session_id == "ses_456"


@pytest.mark.asyncio
async def test_create_opencode_session_raises_after_retry_exhausted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )
    bridge.http_client = AsyncMock()
    bridge.http_client.post.side_effect = [
        httpx.ReadTimeout("timed out"),
        httpx.ReadTimeout("timed out"),
    ]
    bridge._save_session_id = AsyncMock()

    sleep_mock = AsyncMock()
    monkeypatch.setattr("sandbox_runtime.bridge.asyncio.sleep", sleep_mock)

    with pytest.raises(httpx.ReadTimeout):
        await bridge._create_opencode_session()

    assert bridge.http_client.post.await_count == bridge.OPENCODE_SESSION_CREATE_MAX_ATTEMPTS
    sleep_mock.assert_awaited_once_with(bridge.HTTP_RETRY_BACKOFF_SECONDS)
    bridge._save_session_id.assert_not_awaited()
