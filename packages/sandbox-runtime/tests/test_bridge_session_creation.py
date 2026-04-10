"""Tests for OpenCode session creation behavior in AgentBridge."""

from unittest.mock import AsyncMock

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
