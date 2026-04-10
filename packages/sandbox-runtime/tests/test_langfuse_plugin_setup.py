"""Tests for Langfuse plugin configuration in SandboxSupervisor."""

from unittest.mock import patch

from sandbox_runtime.entrypoint import SandboxSupervisor


def _make_supervisor() -> SandboxSupervisor:
    """Create a SandboxSupervisor with default test config."""
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


def test_configures_langfuse_when_both_keys_are_present():
    sup = _make_supervisor()
    opencode_config = {"model": "anthropic/claude-sonnet-4-6"}

    with patch.dict(
        "os.environ",
        {
            "LANGFUSE_PUBLIC_KEY": "pk-lf-test",
            "LANGFUSE_SECRET_KEY": "sk-lf-test",
        },
        clear=False,
    ):
        sup._configure_langfuse(opencode_config)

    assert opencode_config["experimental"] == {"openTelemetry": True}
    assert opencode_config["plugin"] == ["opencode-plugin-langfuse"]


def test_skips_langfuse_when_keys_are_missing():
    sup = _make_supervisor()
    opencode_config = {"model": "anthropic/claude-sonnet-4-6"}

    with patch.dict(
        "os.environ",
        {
            "LANGFUSE_PUBLIC_KEY": "",
            "LANGFUSE_SECRET_KEY": "",
        },
        clear=False,
    ):
        sup._configure_langfuse(opencode_config)

    assert "experimental" not in opencode_config
    assert "plugin" not in opencode_config


def test_skips_langfuse_when_only_one_key_present():
    sup = _make_supervisor()
    opencode_config = {"model": "anthropic/claude-sonnet-4-6"}

    with patch.dict(
        "os.environ",
        {
            "LANGFUSE_PUBLIC_KEY": "pk-lf-test",
            "LANGFUSE_SECRET_KEY": "",
        },
        clear=False,
    ):
        sup._configure_langfuse(opencode_config)

    assert "experimental" not in opencode_config
    assert "plugin" not in opencode_config


def test_preserves_existing_plugin_config_when_enabling_langfuse():
    sup = _make_supervisor()
    opencode_config = {
        "model": "anthropic/claude-sonnet-4-6",
        "plugin": ["existing-plugin"],
    }

    with patch.dict(
        "os.environ",
        {
            "LANGFUSE_PUBLIC_KEY": "pk-lf-test",
            "LANGFUSE_SECRET_KEY": "sk-lf-test",
        },
        clear=False,
    ):
        sup._configure_langfuse(opencode_config)

    assert opencode_config["plugin"] == ["existing-plugin", "opencode-plugin-langfuse"]
