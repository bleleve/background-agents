"""Tests for OpenCode plugin deployment in SandboxSupervisor."""

import shutil
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

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


def _langfuse_env() -> dict[str, str]:
    return {"LANGFUSE_PUBLIC_KEY": "pk-lf-test", "LANGFUSE_SECRET_KEY": "sk-lf-test"}


class TestOpenCodePluginDeployment:
    """Cases for bundled OpenCode plugin deployment."""

    def test_codex_auth_plugin_skipped_without_refresh_token(self, tmp_path):
        sup = _make_supervisor()
        opencode_dir = tmp_path / ".opencode"

        codex_source = tmp_path / "plugins" / "codex-auth-plugin.ts"
        codex_source.parent.mkdir(parents=True)
        codex_source.write_text("// codex plugin")

        with (
            patch.object(SandboxSupervisor, "CODEX_AUTH_PLUGIN_SOURCE_PATH", str(codex_source)),
            patch.dict("os.environ", {"OPENAI_OAUTH_REFRESH_TOKEN": ""}, clear=False),
        ):
            sup._deploy_opencode_plugins(opencode_dir)

        assert not (opencode_dir / "plugins" / "codex-auth-plugin.ts").exists()
        assert not (opencode_dir / "plugins").exists()

    def test_codex_auth_plugin_deployed_with_refresh_token(self, tmp_path):
        sup = _make_supervisor()
        opencode_dir = tmp_path / ".opencode"

        codex_source = tmp_path / "plugins" / "codex-auth-plugin.ts"
        codex_source.parent.mkdir(parents=True)
        codex_source.write_text("// codex plugin")

        with (
            patch.object(SandboxSupervisor, "CODEX_AUTH_PLUGIN_SOURCE_PATH", str(codex_source)),
            patch.dict("os.environ", {"OPENAI_OAUTH_REFRESH_TOKEN": "rt_test"}, clear=False),
        ):
            sup._deploy_opencode_plugins(opencode_dir)

        deployed = opencode_dir / "plugins" / "codex-auth-plugin.ts"
        assert deployed.exists()
        assert deployed.read_text() == "// codex plugin"


class TestSkillSpanPluginDeployment:
    """Cases for skill span plugin deployment (gated on Langfuse keys)."""

    def test_skill_span_plugin_skipped_without_langfuse_keys(self, tmp_path):
        sup = _make_supervisor()
        opencode_dir = tmp_path / ".opencode"

        skill_source = tmp_path / "plugins" / "skill-span-plugin.js"
        skill_source.parent.mkdir(parents=True)
        skill_source.write_text("// skill span plugin")

        with (
            patch.object(SandboxSupervisor, "SKILL_SPAN_PLUGIN_SOURCE_PATH", str(skill_source)),
            patch.dict(
                "os.environ",
                {"LANGFUSE_PUBLIC_KEY": "", "LANGFUSE_SECRET_KEY": ""},
                clear=False,
            ),
        ):
            sup._deploy_opencode_plugins(opencode_dir)

        assert not (opencode_dir / "plugins" / "skill-span-plugin.js").exists()

    def test_skill_span_plugin_skipped_with_only_public_key(self, tmp_path):
        sup = _make_supervisor()
        opencode_dir = tmp_path / ".opencode"

        skill_source = tmp_path / "plugins" / "skill-span-plugin.js"
        skill_source.parent.mkdir(parents=True)
        skill_source.write_text("// skill span plugin")

        with (
            patch.object(SandboxSupervisor, "SKILL_SPAN_PLUGIN_SOURCE_PATH", str(skill_source)),
            patch.dict(
                "os.environ",
                {"LANGFUSE_PUBLIC_KEY": "pk-lf-test", "LANGFUSE_SECRET_KEY": ""},
                clear=False,
            ),
        ):
            sup._deploy_opencode_plugins(opencode_dir)

        assert not (opencode_dir / "plugins" / "skill-span-plugin.js").exists()

    def test_skill_span_plugin_deployed_with_langfuse_keys(self, tmp_path):
        sup = _make_supervisor()
        opencode_dir = tmp_path / ".opencode"

        skill_source = tmp_path / "plugins" / "skill-span-plugin.js"
        skill_source.parent.mkdir(parents=True)
        skill_source.write_text("// skill span plugin")

        with (
            patch.object(SandboxSupervisor, "SKILL_SPAN_PLUGIN_SOURCE_PATH", str(skill_source)),
            patch.dict("os.environ", _langfuse_env(), clear=False),
        ):
            sup._deploy_opencode_plugins(opencode_dir)

        deployed = opencode_dir / "plugins" / "skill-span-plugin.js"
        assert deployed.exists()
        assert deployed.read_text() == "// skill span plugin"

    def test_both_plugins_deployed_when_both_conditions_met(self, tmp_path):
        sup = _make_supervisor()
        opencode_dir = tmp_path / ".opencode"

        codex_source = tmp_path / "plugins" / "codex-auth-plugin.js"
        codex_source.parent.mkdir(parents=True)
        codex_source.write_text("// codex plugin")

        skill_source = tmp_path / "plugins" / "skill-span-plugin.js"
        skill_source.write_text("// skill span plugin")

        with (
            patch.object(SandboxSupervisor, "CODEX_AUTH_PLUGIN_SOURCE_PATH", str(codex_source)),
            patch.object(SandboxSupervisor, "SKILL_SPAN_PLUGIN_SOURCE_PATH", str(skill_source)),
            patch.dict(
                "os.environ",
                {**_langfuse_env(), "OPENAI_OAUTH_REFRESH_TOKEN": "rt_test"},
                clear=False,
            ),
        ):
            sup._deploy_opencode_plugins(opencode_dir)

        assert (opencode_dir / "plugins" / "codex-auth-plugin.js").exists()
        assert (opencode_dir / "plugins" / "skill-span-plugin.js").exists()


class TestSkillSpanPluginBehavior:
    """Behavioral coverage for skill-span-plugin.js's OTEL hooks.

    Deploy gating is covered above; this exercises the plugin's actual
    span-naming and Langfuse metadata-stamping logic via the real `server()`
    hooks (not a source-substring check). See tests/skill_span_plugin_behavior.mjs.
    """

    def test_skill_span_hook_behavior(self):
        node = shutil.which("node")
        if node is None:  # pragma: no cover - node is present on CI
            pytest.skip("node runtime not available")
        harness = Path(__file__).parent / "skill_span_plugin_behavior.mjs"
        result = subprocess.run(
            [node, str(harness)],
            capture_output=True,
            text=True,
            timeout=60,
        )
        assert result.returncode == 0, (
            "skill span plugin behavior harness failed:\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
