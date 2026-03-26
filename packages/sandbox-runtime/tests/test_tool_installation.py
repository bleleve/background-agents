"""Tests for _install_tools() method in SandboxSupervisor."""

from contextlib import contextmanager
from pathlib import Path
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


@contextmanager
def _patch_paths(legacy: Path | str, tools: Path | str, modules: Path | str = "/nonexistent"):
    """Patch Path() calls inside _install_tools to redirect to test paths."""
    with patch("sandbox_runtime.entrypoint.Path") as MockPath:
        MockPath.side_effect = lambda p: Path(
            str(p)
            .replace("/app/sandbox_runtime/plugins/inspect-plugin.js", str(legacy))
            .replace("/app/sandbox_runtime/tools", str(tools))
            .replace("/usr/lib/node_modules", str(modules))
        )
        yield


class TestInstallTools:
    """Cases for _install_tools() tool installation."""

    def test_legacy_tool_copied(self, tmp_path):
        """inspect-plugin.js should be copied as create-pull-request.js."""
        sup = _make_supervisor()
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        legacy_tool = tmp_path / "app" / "sandbox" / "inspect-plugin.js"
        legacy_tool.parent.mkdir(parents=True)
        legacy_tool.write_text("// legacy tool")

        with _patch_paths(legacy=legacy_tool, tools=tmp_path / "no-tools"):
            sup._install_tools(workdir)

        dest = workdir / ".opencode" / "tool" / "create-pull-request.js"
        assert dest.exists()
        assert dest.read_text() == "// legacy tool"

    def test_tools_dir_files_copied(self, tmp_path):
        """All .js files from tools/ directory should be copied."""
        sup = _make_supervisor()
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        tools_dir = tmp_path / "app" / "sandbox" / "tools"
        tools_dir.mkdir(parents=True)
        (tools_dir / "_bridge-client.js").write_text("// bridge client")
        (tools_dir / "spawn-task.js").write_text("// spawn task")
        (tools_dir / "get-task-status.js").write_text("// get status")
        (tools_dir / "cancel-task.js").write_text("// cancel task")

        with _patch_paths(legacy=tmp_path / "no-legacy", tools=tools_dir):
            sup._install_tools(workdir)

        tool_dest = workdir / ".opencode" / "tool"
        assert (tool_dest / "_bridge-client.js").exists()
        assert (tool_dest / "spawn-task.js").exists()
        assert (tool_dest / "get-task-status.js").exists()
        assert (tool_dest / "cancel-task.js").exists()
        assert (tool_dest / "_bridge-client.js").read_text() == "// bridge client"

    def test_non_js_files_skipped(self, tmp_path):
        """Non-.js files in tools/ directory should not be copied."""
        sup = _make_supervisor()
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        tools_dir = tmp_path / "app" / "sandbox" / "tools"
        tools_dir.mkdir(parents=True)
        (tools_dir / "spawn-task.js").write_text("// tool")
        (tools_dir / "README.md").write_text("# docs")
        (tools_dir / "helper.py").write_text("# python")

        with _patch_paths(legacy=tmp_path / "no-legacy", tools=tools_dir):
            sup._install_tools(workdir)

        tool_dest = workdir / ".opencode" / "tool"
        assert (tool_dest / "spawn-task.js").exists()
        assert not (tool_dest / "README.md").exists()
        assert not (tool_dest / "helper.py").exists()

    def test_graceful_without_tools_dir(self, tmp_path):
        """Only legacy tool should be copied when tools/ doesn't exist."""
        sup = _make_supervisor()
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        legacy_tool = tmp_path / "app" / "sandbox" / "inspect-plugin.js"
        legacy_tool.parent.mkdir(parents=True)
        legacy_tool.write_text("// legacy")

        with _patch_paths(legacy=legacy_tool, tools=tmp_path / "no-tools"):
            sup._install_tools(workdir)

        tool_dest = workdir / ".opencode" / "tool"
        assert (tool_dest / "create-pull-request.js").exists()
        js_files = list(tool_dest.glob("*.js"))
        assert len(js_files) == 1

    def test_no_tools_at_all(self, tmp_path):
        """Should be a no-op when neither legacy tool nor tools/ exist."""
        sup = _make_supervisor()
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        with _patch_paths(legacy=tmp_path / "no-legacy", tools=tmp_path / "no-tools"):
            sup._install_tools(workdir)

        assert not (workdir / ".opencode").exists()

    def test_node_modules_symlink_created(self, tmp_path):
        """Node modules symlink and package.json should be created."""
        sup = _make_supervisor()
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        legacy_tool = tmp_path / "app" / "sandbox" / "inspect-plugin.js"
        legacy_tool.parent.mkdir(parents=True)
        legacy_tool.write_text("// tool")

        global_modules = tmp_path / "global-modules"
        global_modules.mkdir()

        with _patch_paths(legacy=legacy_tool, tools=tmp_path / "no-tools", modules=global_modules):
            sup._install_tools(workdir)

        opencode_dir = workdir / ".opencode"
        node_modules = opencode_dir / "node_modules"
        assert node_modules.is_symlink()
        assert node_modules.resolve() == global_modules.resolve()

        package_json = opencode_dir / "package.json"
        assert package_json.exists()
        assert '"type": "module"' in package_json.read_text()

    def test_legacy_and_tools_dir_combined(self, tmp_path):
        """Both legacy tool and tools/ directory files should be installed together."""
        sup = _make_supervisor()
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        legacy_tool = tmp_path / "app" / "sandbox" / "inspect-plugin.js"
        legacy_tool.parent.mkdir(parents=True)
        legacy_tool.write_text("// legacy")

        tools_dir = tmp_path / "app" / "sandbox" / "tools"
        tools_dir.mkdir(parents=True)
        (tools_dir / "spawn-task.js").write_text("// spawn")
        (tools_dir / "_bridge-client.js").write_text("// bridge")

        with _patch_paths(legacy=legacy_tool, tools=tools_dir):
            sup._install_tools(workdir)

        tool_dest = workdir / ".opencode" / "tool"
        assert (tool_dest / "create-pull-request.js").exists()
        assert (tool_dest / "spawn-task.js").exists()
        assert (tool_dest / "_bridge-client.js").exists()
        js_files = list(tool_dest.glob("*.js"))
        assert len(js_files) == 3

    def test_git_exclude_written_on_install(self, tmp_path):
        """.opencode should be added to .git/info/exclude (not .gitignore)."""
        sup = _make_supervisor()
        workdir = tmp_path / "workspace"
        workdir.mkdir()
        # Simulate a git repo by creating .git/info/
        (workdir / ".git" / "info").mkdir(parents=True)

        legacy_tool = tmp_path / "app" / "sandbox" / "inspect-plugin.js"
        legacy_tool.parent.mkdir(parents=True)
        legacy_tool.write_text("// legacy")

        with _patch_paths(legacy=legacy_tool, tools=tmp_path / "no-tools"):
            sup._install_tools(workdir)

        exclude = workdir / ".git" / "info" / "exclude"
        assert exclude.exists()
        assert ".opencode" in exclude.read_text().splitlines()

    def test_gitignore_not_modified_by_install(self, tmp_path):
        """.gitignore must not be touched — changes to it would end up in the PR."""
        sup = _make_supervisor()
        workdir = tmp_path / "workspace"
        workdir.mkdir()
        (workdir / ".git" / "info").mkdir(parents=True)

        original_gitignore = "node_modules\ndist\n"
        (workdir / ".gitignore").write_text(original_gitignore)

        legacy_tool = tmp_path / "app" / "sandbox" / "inspect-plugin.js"
        legacy_tool.parent.mkdir(parents=True)
        legacy_tool.write_text("// legacy")

        with _patch_paths(legacy=legacy_tool, tools=tmp_path / "no-tools"):
            sup._install_tools(workdir)

        assert (workdir / ".gitignore").read_text() == original_gitignore


class TestExcludeOpencodeFromGit:
    """Unit tests for _exclude_opencode_from_git() in isolation."""

    def _make_git_repo(self, path: Path) -> Path:
        """Create a minimal fake git repo directory structure."""
        (path / ".git" / "info").mkdir(parents=True)
        return path

    def test_creates_exclude_file_when_missing(self, tmp_path):
        """Should create .git/info/exclude containing .opencode."""
        sup = _make_supervisor()
        workdir = self._make_git_repo(tmp_path / "repo")
        workdir.mkdir(exist_ok=True)

        sup._exclude_opencode_from_git(workdir)

        exclude = workdir / ".git" / "info" / "exclude"
        assert exclude.exists()
        assert ".opencode" in exclude.read_text().splitlines()

    def test_appends_to_existing_exclude_file(self, tmp_path):
        """Should append .opencode to an existing exclude file."""
        sup = _make_supervisor()
        workdir = self._make_git_repo(tmp_path / "repo")
        workdir.mkdir(exist_ok=True)
        exclude = workdir / ".git" / "info" / "exclude"
        exclude.write_text("# git ls-files --others --exclude-from=.git/info/exclude\n*.log\n")

        sup._exclude_opencode_from_git(workdir)

        lines = exclude.read_text().splitlines()
        assert ".opencode" in lines
        assert "*.log" in lines

    def test_idempotent_when_entry_already_present(self, tmp_path):
        """Calling twice must not duplicate the .opencode entry."""
        sup = _make_supervisor()
        workdir = self._make_git_repo(tmp_path / "repo")
        workdir.mkdir(exist_ok=True)
        exclude = workdir / ".git" / "info" / "exclude"
        original = "*.log\n.opencode\n"
        exclude.write_text(original)

        sup._exclude_opencode_from_git(workdir)

        assert exclude.read_text() == original

    def test_no_op_when_no_git_directory(self, tmp_path):
        """Should not create any files when workdir is not a git repo."""
        sup = _make_supervisor()
        workdir = tmp_path / "not-a-repo"
        workdir.mkdir()

        sup._exclude_opencode_from_git(workdir)

        assert not (workdir / ".git").exists()

    def test_appended_without_trailing_newline(self, tmp_path):
        """Appending .opencode should produce a clean line, not merge with last line."""
        sup = _make_supervisor()
        workdir = self._make_git_repo(tmp_path / "repo")
        workdir.mkdir(exist_ok=True)
        exclude = workdir / ".git" / "info" / "exclude"
        exclude.write_text("*.log")  # no trailing newline

        sup._exclude_opencode_from_git(workdir)

        lines = exclude.read_text().splitlines()
        assert "*.log" in lines
        assert ".opencode" in lines

    def test_partial_match_not_treated_as_present(self, tmp_path):
        """A line '.opencode-extra' must not suppress adding '.opencode'."""
        sup = _make_supervisor()
        workdir = self._make_git_repo(tmp_path / "repo")
        workdir.mkdir(exist_ok=True)
        exclude = workdir / ".git" / "info" / "exclude"
        exclude.write_text(".opencode-extra\n")

        sup._exclude_opencode_from_git(workdir)

        lines = exclude.read_text().splitlines()
        assert ".opencode" in lines
        assert ".opencode-extra" in lines

    def test_gitignore_is_never_touched(self, tmp_path):
        """Writing to .git/info/exclude must never modify .gitignore."""
        sup = _make_supervisor()
        workdir = self._make_git_repo(tmp_path / "repo")
        workdir.mkdir(exist_ok=True)
        original = "node_modules\n"
        (workdir / ".gitignore").write_text(original)

        sup._exclude_opencode_from_git(workdir)

        assert (workdir / ".gitignore").read_text() == original
