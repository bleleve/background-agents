"""Tests for RTK/OpenCode plugin deployment in SandboxSupervisor."""

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


class TestOpenCodePluginDeployment:
    """Cases for bundled OpenCode plugin deployment."""

    def test_deploys_rtk_plugin_when_source_exists(self, tmp_path):
        sup = _make_supervisor()
        opencode_dir = tmp_path / ".opencode"

        rtk_source = tmp_path / "plugins" / "rtk.ts"
        rtk_source.parent.mkdir(parents=True)
        rtk_source.write_text("// rtk plugin")

        with (
            patch.object(SandboxSupervisor, "RTK_PLUGIN_SOURCE_PATH", str(rtk_source)),
            patch.object(
                SandboxSupervisor,
                "CODEX_AUTH_PLUGIN_SOURCE_PATH",
                str(tmp_path / "missing-codex-plugin.ts"),
            ),
            patch.dict("os.environ", {"OPENAI_OAUTH_REFRESH_TOKEN": ""}, clear=False),
        ):
            sup._deploy_opencode_plugins(opencode_dir)

        deployed = opencode_dir / "plugins" / "rtk.ts"
        assert deployed.exists()
        assert deployed.read_text() == "// rtk plugin"

    def test_codex_auth_plugin_skipped_without_refresh_token(self, tmp_path):
        sup = _make_supervisor()
        opencode_dir = tmp_path / ".opencode"

        codex_source = tmp_path / "plugins" / "codex-auth-plugin.ts"
        codex_source.parent.mkdir(parents=True)
        codex_source.write_text("// codex plugin")

        with (
            patch.object(
                SandboxSupervisor,
                "RTK_PLUGIN_SOURCE_PATH",
                str(tmp_path / "missing-rtk-plugin.ts"),
            ),
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
            patch.object(
                SandboxSupervisor,
                "RTK_PLUGIN_SOURCE_PATH",
                str(tmp_path / "missing-rtk-plugin.ts"),
            ),
            patch.object(SandboxSupervisor, "CODEX_AUTH_PLUGIN_SOURCE_PATH", str(codex_source)),
            patch.dict("os.environ", {"OPENAI_OAUTH_REFRESH_TOKEN": "rt_test"}, clear=False),
        ):
            sup._deploy_opencode_plugins(opencode_dir)

        deployed = opencode_dir / "plugins" / "codex-auth-plugin.ts"
        assert deployed.exists()
        assert deployed.read_text() == "// codex plugin"
