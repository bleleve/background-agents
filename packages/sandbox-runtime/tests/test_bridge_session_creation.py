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


def _make_bridge() -> AgentBridge:
    return AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )


@pytest.mark.asyncio
async def test_ensure_session_prefers_already_loaded_id() -> None:
    """A session loaded from disk on a restore is authoritative; ignore the request."""
    bridge = _make_bridge()
    bridge.opencode_session_id = "ses_loaded"
    bridge.http_client = AsyncMock()
    bridge._create_opencode_session = AsyncMock()

    await bridge._ensure_opencode_session("ses_requested")

    assert bridge.opencode_session_id == "ses_loaded"
    bridge.http_client.get.assert_not_awaited()
    bridge._create_opencode_session.assert_not_awaited()


@pytest.mark.asyncio
async def test_ensure_session_adopts_valid_requested_id() -> None:
    """A control-plane-supplied id that exists locally is adopted (resume path)."""
    bridge = _make_bridge()
    bridge.opencode_session_id = None
    bridge.http_client = AsyncMock()
    bridge.http_client.get.return_value = MockResponse(200, {"id": "ses_resume"})
    bridge._session_has_user_prompt = AsyncMock(return_value=True)
    bridge._save_session_id = AsyncMock()
    bridge._create_opencode_session = AsyncMock()

    await bridge._ensure_opencode_session("ses_resume")

    assert bridge.opencode_session_id == "ses_resume"
    bridge.http_client.get.assert_awaited_once_with(
        "http://localhost:4096/session/ses_resume",
        timeout=bridge.OPENCODE_REQUEST_TIMEOUT,
    )
    bridge._save_session_id.assert_awaited_once()
    bridge._create_opencode_session.assert_not_awaited()


@pytest.mark.asyncio
async def test_ensure_session_falls_back_when_requested_id_invalid() -> None:
    """A first-turn relaunch has no snapshot, so the dead id 404s → create fresh."""
    bridge = _make_bridge()
    bridge.opencode_session_id = None
    bridge.http_client = AsyncMock()
    bridge.http_client.get.return_value = MockResponse(404)
    bridge._save_session_id = AsyncMock()
    bridge._create_opencode_session = AsyncMock()

    await bridge._ensure_opencode_session("ses_dead")

    bridge.http_client.get.assert_awaited_once()
    bridge._create_opencode_session.assert_awaited_once()
    # adopt must not have stored the dead id
    assert bridge.opencode_session_id is None
    bridge._save_session_id.assert_not_awaited()


@pytest.mark.asyncio
async def test_ensure_session_falls_back_when_validation_raises() -> None:
    """A transport error during validation must not crash the prompt — create fresh."""
    bridge = _make_bridge()
    bridge.opencode_session_id = None
    bridge.http_client = AsyncMock()
    bridge.http_client.get.side_effect = httpx.ConnectError("boom")
    bridge._create_opencode_session = AsyncMock()

    await bridge._ensure_opencode_session("ses_unreachable")

    bridge._create_opencode_session.assert_awaited_once()
    assert bridge.opencode_session_id is None


@pytest.mark.asyncio
async def test_ensure_session_creates_fresh_when_no_request() -> None:
    """No loaded id and nothing requested → plain fresh session."""
    bridge = _make_bridge()
    bridge.opencode_session_id = None
    bridge.http_client = AsyncMock()
    bridge._create_opencode_session = AsyncMock()

    await bridge._ensure_opencode_session(None)

    bridge.http_client.get.assert_not_awaited()
    bridge._create_opencode_session.assert_awaited_once()
