"""Tests for REEF_REVIEW_SESSION env var passthrough in sandbox creation.

Mirrors test_agent_slack_notify_env.py: the flag is a per-session boolean that
becomes the REEF_REVIEW_SESSION env var, which switches the gh guard to block
raw issue comments in a dedicated PR review session (verdict-only via the tool).
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from src.sandbox.manager import SandboxConfig, SandboxManager


def _patch_create(monkeypatch, captured: dict) -> None:
    """Patch modal.Sandbox.create to capture the env passed in."""

    async def fake_create_aio(*args, **kwargs):
        captured["env"] = kwargs.get("env")

        class FakeSandbox:
            object_id = "obj-123"
            stdout = None

        return FakeSandbox()

    fake_create = MagicMock()
    fake_create.aio = fake_create_aio
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create)
    monkeypatch.setattr(
        SandboxManager,
        "_resolve_and_setup_tunnels",
        AsyncMock(return_value=(None, None, None)),
    )


class TestCreateSandboxReviewSession:
    """create_sandbox sets REEF_REVIEW_SESSION only when configured on."""

    @pytest.mark.asyncio
    async def test_env_set_when_enabled(self, monkeypatch):
        captured: dict = {}
        _patch_create(monkeypatch, captured)

        manager = SandboxManager()
        config = SandboxConfig(
            repo_owner="acme",
            repo_name="repo",
            control_plane_url="https://cp.example.com",
            sandbox_auth_token="token-123",
            review_session=True,
        )

        await manager.create_sandbox(config)

        assert captured["env"]["REEF_REVIEW_SESSION"] == "true"

    @pytest.mark.asyncio
    async def test_env_omitted_when_default(self, monkeypatch):
        captured: dict = {}
        _patch_create(monkeypatch, captured)

        manager = SandboxManager()
        config = SandboxConfig(
            repo_owner="acme",
            repo_name="repo",
            control_plane_url="https://cp.example.com",
            sandbox_auth_token="token-123",
        )

        await manager.create_sandbox(config)

        assert "REEF_REVIEW_SESSION" not in captured["env"]


class TestRestoreFromSnapshotReviewSession:
    """restore_from_snapshot sets REEF_REVIEW_SESSION only when configured on."""

    @pytest.mark.asyncio
    async def test_env_set_when_enabled(self, monkeypatch):
        captured: dict = {}

        class FakeImage:
            object_id = "img-123"

        monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", lambda *a, **k: FakeImage())
        _patch_create(monkeypatch, captured)

        manager = SandboxManager()
        await manager.restore_from_snapshot(
            snapshot_image_id="img-123",
            session_config={"repo_owner": "acme", "repo_name": "repo"},
            sandbox_id="sb-1",
            control_plane_url="https://cp.example.com",
            sandbox_auth_token="token-123",
            review_session=True,
        )

        assert captured["env"]["REEF_REVIEW_SESSION"] == "true"

    @pytest.mark.asyncio
    async def test_env_omitted_when_default(self, monkeypatch):
        captured: dict = {}

        class FakeImage:
            object_id = "img-123"

        monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", lambda *a, **k: FakeImage())
        _patch_create(monkeypatch, captured)

        manager = SandboxManager()
        await manager.restore_from_snapshot(
            snapshot_image_id="img-123",
            session_config={"repo_owner": "acme", "repo_name": "repo"},
            sandbox_id="sb-1",
            control_plane_url="https://cp.example.com",
            sandbox_auth_token="token-123",
        )

        assert "REEF_REVIEW_SESSION" not in captured["env"]
