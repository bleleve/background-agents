"""Tests for Modal filesystem snapshot timeout configuration."""

from types import SimpleNamespace
from unittest.mock import MagicMock

from sandbox_runtime.types import SandboxStatus
from src.sandbox.manager import (
    DEFAULT_SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS,
    SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS,
    SandboxHandle,
    SandboxManager,
    _resolve_snapshot_timeout_seconds,
)


def test_snapshot_timeout_defaults_to_constant(monkeypatch):
    """With no override env var, the resolved timeout is the default."""
    monkeypatch.delenv("IMAGE_SNAPSHOT_TIMEOUT_SECONDS", raising=False)
    assert _resolve_snapshot_timeout_seconds() == DEFAULT_SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS


def test_snapshot_timeout_env_override(monkeypatch):
    """IMAGE_SNAPSHOT_TIMEOUT_SECONDS overrides the default for heavy repos."""
    monkeypatch.setenv("IMAGE_SNAPSHOT_TIMEOUT_SECONDS", "1500")
    assert _resolve_snapshot_timeout_seconds() == 1500


def test_take_snapshot_passes_explicit_timeout():
    """Session snapshots should not rely on Modal's short default timeout."""
    image = SimpleNamespace(object_id="im-session")
    snapshot_filesystem = MagicMock(return_value=image)
    handle = SandboxHandle(
        sandbox_id="sandbox-1",
        modal_sandbox=SimpleNamespace(snapshot_filesystem=snapshot_filesystem),
        status=SandboxStatus.READY,
        created_at=0,
    )

    image_id = SandboxManager().take_snapshot(handle)

    assert image_id == "im-session"
    snapshot_filesystem.assert_called_once_with(timeout=SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS)
