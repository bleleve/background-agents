#!/usr/bin/env python3
"""
Sandbox entrypoint - manages OpenCode server and bridge lifecycle.

Runs as PID 1 inside the sandbox. Responsibilities:
1. Perform git sync with latest code
2. Run repo hooks (setup/start) based on boot mode
3. Start OpenCode server
4. Start bridge process for control plane communication
5. Monitor processes and restart on crash with exponential backoff
6. Handle graceful shutdown on SIGTERM/SIGINT
"""

import asyncio
import contextlib
import json
import os
import re
import shutil
import signal
import time
from pathlib import Path

import httpx

from .constants import (
    CODE_SERVER_PORT,
    EXPECTED_TUNNEL_PORTS_ENV_VAR,
    SANDBOX_ENV_FILE_PATH,
    TTYD_PORT,
    TTYD_PROXY_PORT,
    TUNNEL_ENV_FILE_PATH,
)
from .log_config import configure_logging, get_logger
from .repo_image_callback import RepoImageBuildCallback

configure_logging()


def _deep_merge(base: dict, override: dict) -> dict:
    """
    Recursively merge two dicts. Values in override win for non-dict values.
    For dict values, recursively merge. Arrays and primitives from override replace base.
    """
    result = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


# Maps tool filename → env var that gates its installation. A tool is installed
# only when its env var is set to "true" (case-insensitive). Two naming schemes:
#   Legacy: AGENT_SLACK_NOTIFY_ENABLED (pre-existing, kept for back-compat)
#   Generic: AGENT_TOOL_<UPPER_SNAKE> (e.g. "ast-anchor.js" → AGENT_TOOL_AST_ANCHOR_JS)
#            Set via agentToolFlags in the control-plane session config.
AGENT_TOOLS_GATED_ON_ENV: dict[str, str] = {
    "slack-notify.js": "AGENT_SLACK_NOTIFY_ENABLED",
    "ast-anchor.js": "AGENT_TOOL_AST_ANCHOR_JS",
    "validate-suggestion.js": "AGENT_TOOL_VALIDATE_SUGGESTION_JS",
    "record-suggestion.js": "AGENT_TOOL_RECORD_SUGGESTION_JS",
}

# Wrapper installed at /usr/local/bin/gh (ahead of the real /usr/bin/gh in
# PATH). It does two things, in order:
#
#  1. Policy guard — the `gh-guard` action inspects argv and exits 3 when this
#     session is forbidden from submitting a formal PR review (APPROVE /
#     REQUEST_CHANGES). The decision logic lives in Python (auditable, tested);
#     argv parsing in POSIX sh would be too fragile. The guard never reads
#     stdin, so the eventual `exec gh "$@"` keeps the original stdin intact
#     (the `-f body=...` / `--input -` paths still work).
#  2. Token mint — the git credential helper can't authenticate the GitHub CLI
#     (gh reads GH_TOKEN/GITHUB_TOKEN from the environment, not git's protocol).
#     The `gh-token` action prints a fresh token when one is needed; we export
#     it as GH_TOKEN, otherwise gh runs with its own env.
GH_WRAPPER_REAL_PATH = "/usr/bin/gh"
# Exit code the `gh-guard` action returns to signal "blocked by policy". Kept
# distinct from gh's own 1/2/4 so the block is unambiguous in logs.
GH_GUARD_BLOCK_RC = 3
GH_WRAPPER_BODY = (
    "#!/bin/sh\n"
    f'REAL_GH="{GH_WRAPPER_REAL_PATH}"\n'
    # Guard first. The block message is written to stderr by the action; exit 3
    # propagates so gh never runs. Any other guard exit (e.g. an internal error)
    # falls through to allow, so the guard can never break legitimate gh use —
    # the control-plane backstop is the safety net for that residual case.
    'python3 -m sandbox_runtime.credentials.git_credential_helper gh-guard "$@"\n'
    f'[ "$?" -eq {GH_GUARD_BLOCK_RC} ] && exit {GH_GUARD_BLOCK_RC}\n'
    # stderr is left attached so the helper's diagnostic surfaces when a
    # refresh fails — otherwise the user just sees an opaque gh 401.
    "token=$(python3 -m sandbox_runtime.credentials.git_credential_helper gh-token || true)\n"
    'if [ -n "$token" ]; then\n'
    # export (not `env GH_TOKEN=… exec`) so the token never lands in argv.
    '  export GH_TOKEN="$token"\n'
    "fi\n"
    'exec "$REAL_GH" "$@"\n'
)


class SandboxSupervisor:
    """
    Supervisor process for sandbox lifecycle management.

    Manages:
    - Git synchronization with base branch
    - OpenCode server process
    - Bridge process for control plane communication
    - Process monitoring with crash recovery
    """

    # Configuration
    OPENCODE_PORT = 4096
    HEALTH_CHECK_TIMEOUT = 30.0
    MAX_RESTARTS = 5
    BACKOFF_BASE = 2.0
    BACKOFF_MAX = 60.0
    SETUP_SCRIPT_PATH = "scripts/.openinspect/setup.sh"
    START_SCRIPT_PATH = "scripts/.openinspect/start.sh"
    DEFAULT_SETUP_TIMEOUT_SECONDS = 1800
    DEFAULT_START_TIMEOUT_SECONDS = 120
    DEFAULT_TUNNEL_WAIT_TIMEOUT_SECONDS = 30
    TUNNEL_WAIT_POLL_INTERVAL_SECONDS = 0.2
    CLONE_DEPTH_COMMITS = 100
    SIDECAR_TIMEOUT_SECONDS = 5
    LANGFUSE_PLUGIN_NAME = "opencode-plugin-langfuse"
    RTK_PLUGIN_SOURCE_PATH = "/app/sandbox_runtime/plugins/rtk.ts"
    CODEX_AUTH_PLUGIN_SOURCE_PATH = "/app/sandbox_runtime/plugins/codex-auth-plugin.js"
    MCP_PACKAGE_INSTALL_TIMEOUT_SECONDS = 180
    # How often to ping the control plane while booting so a long setup.sh
    # doesn't trip the connecting-timeout watchdog. Must stay well under the
    # control plane's connecting/heartbeat timeouts (120s / 90s).
    BOOT_PROGRESS_INTERVAL_SECONDS = 20
    # Cap for the build-time OpenCode DB pre-migration. Generous because it
    # only runs during image builds (already minutes long), never at session
    # boot. OpenCode warns the migration "may take a few minutes".
    OPENCODE_PREWARM_TIMEOUT_SECONDS = 300

    def __init__(self):
        self.opencode_process: asyncio.subprocess.Process | None = None
        self.bridge_process: asyncio.subprocess.Process | None = None
        self.code_server_process: asyncio.subprocess.Process | None = None
        self.ttyd_process: asyncio.subprocess.Process | None = None
        self.ttyd_proxy_process: asyncio.subprocess.Process | None = None
        self._boot_progress_task: asyncio.Task[None] | None = None
        self.shutdown_event = asyncio.Event()
        self.git_sync_complete = asyncio.Event()
        self.opencode_ready = asyncio.Event()
        self.boot_mode = "unknown"

        # Configuration from environment (set by Modal/SandboxManager)
        self.sandbox_id = os.environ.get("SANDBOX_ID", "unknown")
        self.control_plane_url = os.environ.get("CONTROL_PLANE_URL", "")
        self.sandbox_token = os.environ.get("SANDBOX_AUTH_TOKEN", "")
        self.repo_owner = os.environ.get("REPO_OWNER", "")
        self.repo_name = os.environ.get("REPO_NAME", "")
        self.vcs_host = os.environ.get("VCS_HOST", "github.com")
        # Note: VCS credentials are no longer captured at sandbox start. Git
        # operations authenticate per-call via the system-wide credential
        # helper (`/usr/local/bin/oi-git-credentials`), which fetches fresh
        # tokens from the control plane.

        # Parse session config if provided
        session_config_json = os.environ.get("SESSION_CONFIG", "{}")
        self.session_config = json.loads(session_config_json)

        # Paths
        self.workspace_path = Path("/workspace")
        self.repo_path = self.workspace_path / self.repo_name
        self.session_id_file = Path("/tmp/opencode-session-id")

        # Logger
        self.session_id = self.session_config.get("session_id", "")
        self.log = get_logger(
            "supervisor",
            service="sandbox",
            sandbox_id=self.sandbox_id,
            session_id=self.session_id,
        )

    @property
    def base_branch(self) -> str:
        """The branch to clone/fetch — defaults to 'main'."""
        return self.session_config.get("branch") or "main"

    def _build_repo_url(self) -> str:
        """Build the plain HTTPS URL for the repository.

        Authentication is supplied per-request by the system git credential
        helper, so the remote URL itself never carries a secret.
        """
        return f"https://{self.vcs_host}/{self.repo_owner}/{self.repo_name}.git"

    def _redact_git_stderr(self, stderr_text: str) -> str:
        """Redact credential-bearing URLs from git stderr.

        The credential helper means our own remotes are token-free, but git
        may surface upstream URLs (e.g. from submodules or HTTP redirects)
        that still embed credentials.
        """
        return re.sub(r"(https?://)([^/\s@]+)@", r"\1***@", stderr_text)

    # ------------------------------------------------------------------
    # Git primitives
    # ------------------------------------------------------------------

    async def _clone_repo(self) -> bool:
        """Shallow-clone the repository.

        The remote URL is unauthenticated — the system-wide git credential
        helper supplies short-lived credentials per request.
        """
        self.log.info(
            "git.clone_start",
            repo_owner=self.repo_owner,
            repo_name=self.repo_name,
        )

        result = await asyncio.create_subprocess_exec(
            "git",
            "clone",
            "--depth",
            str(self.CLONE_DEPTH_COMMITS),
            "--branch",
            self.base_branch,
            self._build_repo_url(),
            str(self.repo_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _stdout, stderr = await result.communicate()

        if result.returncode != 0:
            self.log.error(
                "git.clone_error",
                stderr=self._redact_git_stderr(stderr.decode()),
                exit_code=result.returncode,
            )
            return False

        self.log.info("git.clone_complete", repo_path=str(self.repo_path))
        return True

    async def _ensure_credential_helper_configured(self) -> None:
        """Make sure git knows about our credential helper, even on old images.

        New base images install the helper system-wide
        (``git config --system credential.helper /usr/local/bin/oi-git-credentials``),
        but a sandbox booting from a snapshot or repo image built *before*
        this migration won't have that config. We re-apply the equivalent at
        the global level on every boot so the flow is robust regardless of
        image age.

        Writing the shim itself is also idempotent: each boot ensures the
        script is present at ``/usr/local/bin/oi-git-credentials`` and
        executable, so old images that lack it get patched in place.

        Failures here are logged but not fatal — if git already has the
        helper configured (the common case on new images), this is a no-op.
        """
        shim_path = Path("/usr/local/bin/oi-git-credentials")
        shim_body = (
            '#!/bin/sh\nexec python3 -m sandbox_runtime.credentials.git_credential_helper "$@"\n'
        )
        shim_available = False
        try:
            if shim_path.exists() and shim_path.read_text() == shim_body:
                shim_available = True
            else:
                shim_path.write_text(shim_body)
                shim_path.chmod(0o755)
                shim_available = True
        except OSError as e:
            # /usr/local/bin not writable in some sandboxed runs; the system
            # config baked into the image is the primary path anyway.
            self.log.warn("credential_helper.shim_write_failed", error=str(e))

        # credential.useHttpPath makes git include the repo path in helper
        # requests. The helper currently authorizes by host to preserve
        # installation-wide token behavior, but keeping the path available
        # preserves Git LFS behavior and leaves room for provider-specific
        # policy later.
        configs = [("credential.useHttpPath", "true")]
        if shim_available:
            configs.insert(0, ("credential.helper", str(shim_path)))

        for key, value in configs:
            proc = await asyncio.create_subprocess_exec(
                "git",
                "config",
                "--global",
                "--replace-all",
                key,
                value,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _stdout, stderr = await proc.communicate()
            if proc.returncode != 0:
                self.log.warn(
                    "credential_helper.config_failed",
                    config_key=key,
                    exit_code=proc.returncode,
                    stderr=stderr.decode(errors="replace"),
                )

        self._install_gh_wrapper()

    def _install_gh_wrapper(self) -> None:
        """Install the gh CLI wrapper at /usr/local/bin/gh.

        See ``GH_WRAPPER_BODY`` for the wrapper's behaviour. Installed at boot
        (rather than baked into the image) so it also patches snapshots and
        repo images built before this migration.
        """
        wrapper_path = Path("/usr/local/bin/gh")
        try:
            # Only install if the real gh exists and we're not about to shadow
            # ourselves (defensive against a previous wrapper at /usr/bin/gh).
            if Path(GH_WRAPPER_REAL_PATH).exists() and (
                not wrapper_path.exists() or wrapper_path.read_text() != GH_WRAPPER_BODY
            ):
                wrapper_path.write_text(GH_WRAPPER_BODY)
                wrapper_path.chmod(0o755)
        except OSError as e:
            self.log.debug("gh_wrapper.install_failed", error=str(e))

    async def _ensure_plain_origin(self) -> bool:
        """Rewrite the `origin` remote to a credential-free HTTPS URL.

        Older workspaces/images (from before the credential-helper migration)
        may embed a GitHub App installation token in the `origin` URL. Modal
        snapshot restores receive a fresh fallback token, but long-running
        sandboxes and Daytona persistent resumes can outlive embedded tokens.
        Normalizing `origin` keeps git fetches routed through the helper.

        Returns False on failure — callers must short-circuit, since a
        credentialed URL can produce an opaque 401 from upstream rather than
        routing through the helper.

        Idempotent — safe to call on every boot.
        """
        expected_url = self._build_repo_url()
        proc = await asyncio.create_subprocess_exec(
            "git",
            "remote",
            "set-url",
            "origin",
            expected_url,
            cwd=self.repo_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            self.log.error(
                "git.set_url_failed",
                exit_code=proc.returncode,
                stderr=self._redact_git_stderr(stderr.decode()),
            )
            return False
        return True

    async def _fetch_branch(self, branch: str) -> bool:
        """Fetch a branch with an explicit refspec.

        Uses an explicit refspec so that ``refs/remotes/origin/<branch>`` is
        created even in shallow or single-branch clones.
        """
        result = await asyncio.create_subprocess_exec(
            "git",
            "fetch",
            "origin",
            f"{branch}:refs/remotes/origin/{branch}",
            cwd=self.repo_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _stdout, stderr = await result.communicate()
        if result.returncode != 0:
            self.log.error(
                "git.fetch_error",
                stderr=self._redact_git_stderr(stderr.decode()),
                exit_code=result.returncode,
            )
            return False
        return True

    async def _stash_local_changes(self) -> bool:
        """Stash any uncommitted local changes so a checkout can proceed cleanly.

        Uses ``git stash --include-untracked`` so that both tracked modifications
        and untracked files (e.g. generated lock-file updates written by a
        previous session) are moved out of the way before the branch reset.

        Returns True if the stash succeeded (or there was nothing to stash),
        False on unexpected failure.
        """
        result = await asyncio.create_subprocess_exec(
            "git",
            "stash",
            "--include-untracked",
            cwd=self.repo_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await result.communicate()
        if result.returncode != 0:
            self.log.warn(
                "git.stash_failed",
                stderr=self._redact_git_stderr(stderr.decode()),
                exit_code=result.returncode,
            )
            return False
        stash_output = stdout.decode().strip()
        if stash_output and stash_output != "No local changes to stash":
            self.log.info("git.stash_created", stash_output=stash_output)
        return True

    async def _checkout_branch(self, branch: str) -> bool:
        """Create/reset a local branch to match the remote tip.

        Stashes any uncommitted local changes before the checkout so that
        working-tree modifications (e.g. lock-file regenerations from a
        previous session) do not block the branch reset.
        """
        if not await self._stash_local_changes():
            # Stash failure is non-fatal; attempt the checkout anyway —
            # it will fail loudly below if the working tree is still dirty.
            self.log.warn("git.stash_skipped", reason="stash_failed")

        result = await asyncio.create_subprocess_exec(
            "git",
            "checkout",
            "-B",
            branch,
            f"origin/{branch}",
            cwd=self.repo_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _stdout, stderr = await result.communicate()
        if result.returncode != 0:
            self.log.warn(
                "git.checkout_error",
                stderr=self._redact_git_stderr(stderr.decode()),
                exit_code=result.returncode,
                target_branch=branch,
            )
            return False
        return True

    # ------------------------------------------------------------------
    # Git sync methods (compose the primitives above)
    # ------------------------------------------------------------------

    async def _update_existing_repo(self) -> bool:
        """Fetch the target branch and check it out in an existing repo.

        Used by both snapshot-restore and repo-image boot paths where the
        repository already exists on disk.
        """
        if not self.repo_path.exists():
            self.log.info("git.update_skip", reason="no_repo_path")
            return False

        try:
            if not await self._ensure_plain_origin():
                return False
            branch = self.base_branch
            if not await self._fetch_branch(branch):
                return False
            return await self._checkout_branch(branch)
        except Exception as e:
            self.log.error("git.update_error", exc=e)
            return False

    async def _get_head_sha(self) -> str:
        """Return the HEAD SHA of the repo, or empty string on failure."""
        if not self.repo_path.exists():
            return ""
        try:
            result = await asyncio.create_subprocess_exec(
                "git",
                "rev-parse",
                "HEAD",
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await result.communicate()
            if result.returncode == 0:
                return stdout.decode().strip()
        except Exception as e:
            self.log.warn("git.rev_parse_error", error=str(e))
        return ""

    async def perform_git_sync(self) -> bool:
        """Clone repository if needed, then sync to the target branch.

        Returns:
            True if sync completed successfully, False otherwise.
        """
        self.log.debug(
            "git.sync_start",
            repo_owner=self.repo_owner,
            repo_name=self.repo_name,
            repo_path=str(self.repo_path),
        )

        if not self.repo_path.exists():
            if not self.repo_owner or not self.repo_name:
                self.log.info("git.skip_clone", reason="no_repo_configured")
                return True
            if not await self._clone_repo():
                return False

        return await self._update_existing_repo()

    def _install_tools(self, workdir: Path) -> None:
        """Copy custom tools into the .opencode/tool directory for OpenCode to discover."""
        opencode_dir = workdir / ".opencode"
        tool_dest = opencode_dir / "tool"

        # Legacy tool (inspect-plugin.js → create-pull-request.js)
        legacy_tool = Path("/app/sandbox_runtime/plugins/inspect-plugin.js")
        # New tools directory
        tools_dir = Path("/app/sandbox_runtime/tools")

        has_tools = legacy_tool.exists() or tools_dir.exists()
        if not has_tools:
            return

        tool_dest.mkdir(parents=True, exist_ok=True)

        if legacy_tool.exists():
            shutil.copy(legacy_tool, tool_dest / "create-pull-request.js")

        # Copy all .js files from tools/ — these must export tool() for OpenCode.
        # Tools listed in AGENT_TOOLS_GATED_ON_ENV are skipped unless their gate
        # env var is "true".
        if tools_dir.exists():
            for tool_file in tools_dir.iterdir():
                if not (tool_file.is_file() and tool_file.suffix == ".js"):
                    continue
                gate_env = AGENT_TOOLS_GATED_ON_ENV.get(tool_file.name)
                if gate_env and os.environ.get(gate_env, "").lower() != "true":
                    continue
                shutil.copy(tool_file, tool_dest / tool_file.name)

        # Copy pre-built deps (package.json, package-lock.json, node_modules)
        # from the image staging directory.  This gives OpenCode a lockfile
        # that matches the declared dependencies so Npm.install() finds
        # everything in sync and skips arborist reify() entirely.
        deps_cache = Path("/app/opencode-deps")
        for name in ("package.json", "package-lock.json"):
            src = deps_cache / name
            dest = opencode_dir / name
            if src.exists() and not dest.exists():
                shutil.copy2(src, dest)
        cached_modules = deps_cache / "node_modules"
        local_modules = opencode_dir / "node_modules"
        if cached_modules.is_dir() and not local_modules.exists():
            shutil.copytree(cached_modules, local_modules, symlinks=True)

        # Ensure .opencode is excluded from git tracking in the cloned repo.
        self._exclude_opencode_from_git(workdir)

    def _install_bin_scripts(self) -> None:
        """Install standalone CLI scripts into /usr/local/bin.

        Scripts in bin/ are standalone CLIs (not OpenCode tool plugins) and must
        NOT be placed in .opencode/tool/ — OpenCode would import() them during
        tool discovery, executing module-level code with the parent process argv.
        """
        bin_dir = Path("/app/sandbox_runtime/bin")
        if not bin_dir.is_dir():
            return

        for script in bin_dir.iterdir():
            if script.is_file() and script.suffix == ".js":
                dest = Path("/usr/local/bin") / script.stem
                shutil.copy(script, dest)
                dest.chmod(0o755)
                self.log.info("bin.installed", script=script.stem)

    def _install_skills(self, workdir: Path) -> None:
        """Copy bundled Skills into the .opencode/skills directory."""
        skills_dir = Path("/app/sandbox_runtime/skills")
        if not skills_dir.is_dir():
            return

        skills_dest = workdir / ".opencode" / "skills"
        installed_any = False

        for skill_dir in skills_dir.iterdir():
            skill_file = skill_dir / "SKILL.md"
            if not skill_dir.is_dir() or not skill_file.exists():
                continue

            dest_dir = skills_dest / skill_dir.name
            # Preserve symlinks rather than dereferencing paths outside the bundled skill.
            shutil.copytree(
                skill_dir,
                dest_dir,
                dirs_exist_ok=True,
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"),
                symlinks=True,
            )
            installed_any = True

        if installed_any:
            self.log.info("opencode.skills_installed", skills_path=str(skills_dest))

        # Ensure .opencode is excluded from git tracking in the cloned repo.
        # We write to .git/info/exclude (not .gitignore) so the rule is
        # local to this sandbox clone and can never be staged, committed,
        # or pushed by the agent.
        self._exclude_opencode_from_git(workdir)

    def _install_agents(self) -> None:
        """Copy bundled agent definitions into ~/.config/opencode/agents."""
        agents_dir = Path("/app/sandbox_runtime/agents")
        if not agents_dir.is_dir():
            return

        agents_dest = Path.home() / ".config" / "opencode" / "agents"
        shutil.copytree(agents_dir, agents_dest, dirs_exist_ok=True)
        self.log.info("opencode.agents_installed", agents_path=str(agents_dest))

    def _exclude_opencode_from_git(self, workdir: Path) -> None:
        """Add sandbox-local paths to .git/info/exclude so they are never committed.

        .git/info/exclude is equivalent to .gitignore but lives inside .git/,
        which git never tracks. Writing here has no effect on the working tree
        and cannot appear in any commit or pull request.
        """
        exclude_path = workdir / ".git" / "info" / "exclude"
        entries = [
            ".opencode",
            "docker-compose.openinspect-override.yml",
        ]

        if not exclude_path.parent.exists():
            # No .git directory — workdir is not a git repo, nothing to do.
            return

        if exclude_path.exists():
            existing = exclude_path.read_text()
            existing_lines = {line.strip() for line in existing.splitlines()}
            missing = [e for e in entries if e not in existing_lines]
            if not missing:
                return
            suffix = "" if existing.endswith("\n") else "\n"
            exclude_path.write_text(existing + suffix + "\n".join(missing) + "\n")
        else:
            exclude_path.parent.mkdir(parents=True, exist_ok=True)
            exclude_path.write_text("\n".join(entries) + "\n")

    def _setup_aws_credentials(self) -> None:
        """
        Write ~/.aws/credentials from AWS_CREDENTIALS_FILE_CONTENT if set.

        The Modal function manager assumes IAM roles via OIDC before sandbox
        creation and stores the resulting INI credentials file as this env var.
        Writing here (early in startup) ensures AWS CLI and SDKs in the sandbox
        find credentials before any user code or hooks run.

        The file is created with 0o600 permissions (owner-read/write only).
        """
        content = os.environ.get("AWS_CREDENTIALS_FILE_CONTENT")
        if not content:
            return

        try:
            aws_dir = Path.home() / ".aws"
            aws_dir.mkdir(mode=0o700, parents=True, exist_ok=True)

            credentials_path = aws_dir / "credentials"
            tmp_path = aws_dir / ".credentials.tmp"

            # Write to a temp file with 0o600 from the start, then atomically rename
            fd = os.open(str(tmp_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            try:
                os.write(fd, content.encode())
            finally:
                os.close(fd)
            tmp_path.replace(credentials_path)

            self.log.info("aws.credentials_written", path=str(credentials_path))
        except Exception as e:
            self.log.warn("aws.credentials_write_error", exc=e)

    # Path where the static kubeconfig is baked into the sandbox image by base.py.
    KUBECONFIG_IMAGE_PATH = "/etc/kubeconfig"

    def _setup_eks_kubeconfig(self) -> None:
        """
        Copy /etc/kubeconfig (baked into the image) to ~/.kube/config.

        Does nothing if ~/.aws/credentials does not exist (no AWS credentials
        were injected for this sandbox, so kubectl would not be able to auth)
        or if the source file is absent from the image.
        """
        source = Path(self.KUBECONFIG_IMAGE_PATH)
        if not source.exists():
            return

        credentials_path = Path.home() / ".aws" / "credentials"
        if not credentials_path.exists():
            return

        try:
            kube_dir = Path.home() / ".kube"
            kube_dir.mkdir(mode=0o700, parents=True, exist_ok=True)

            config_path = kube_dir / "config"
            tmp_path = kube_dir / ".config.tmp"

            # Copy via a temp file so the target is never partially written.
            shutil.copy2(str(source), str(tmp_path))
            Path.chmod(str(tmp_path), 0o600)
            tmp_path.replace(config_path)

            self.log.info("eks.kubeconfig_written", path=str(config_path))
        except Exception as e:
            self.log.warn("eks.kubeconfig_write_error", exc=e)

    def _setup_openai_oauth(self) -> None:
        """Write OpenCode auth.json for ChatGPT OAuth if refresh token is configured."""
        refresh_token = os.environ.get("OPENAI_OAUTH_REFRESH_TOKEN")
        if not refresh_token:
            return

        try:
            auth_dir = Path.home() / ".local" / "share" / "opencode"
            auth_dir.mkdir(parents=True, exist_ok=True)

            openai_entry = {
                "type": "oauth",
                "refresh": "managed-by-control-plane",
                "access": "",
                "expires": 0,
            }

            account_id = os.environ.get("OPENAI_OAUTH_ACCOUNT_ID")
            if account_id:
                openai_entry["accountId"] = account_id

            auth_file = auth_dir / "auth.json"
            tmp_file = auth_dir / ".auth.json.tmp"

            # Write to a temp file created with 0o600 from the start, then
            # atomically rename so the target is never world-readable.
            fd = os.open(str(tmp_file), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            try:
                os.write(fd, json.dumps({"openai": openai_entry}).encode())
            finally:
                os.close(fd)
            tmp_file.replace(auth_file)

            self.log.info("openai_oauth.setup")
        except Exception as e:
            self.log.warn("openai_oauth.setup_error", exc=e)

    def _deploy_opencode_plugins(self, opencode_dir: Path) -> None:
        """Deploy bundled OpenCode plugins into .opencode/plugins."""
        plugins_to_copy: list[tuple[Path, str, str]] = []

        rtk_source = Path(self.RTK_PLUGIN_SOURCE_PATH)
        if rtk_source.exists():
            plugins_to_copy.append((rtk_source, "rtk.ts", "rtk.plugin_deployed"))

        codex_source = Path(self.CODEX_AUTH_PLUGIN_SOURCE_PATH)
        if codex_source.exists() and os.environ.get("OPENAI_OAUTH_REFRESH_TOKEN"):
            plugins_to_copy.append(
                (codex_source, codex_source.name, "openai_oauth.plugin_deployed")
            )

        if not plugins_to_copy:
            return

        plugin_dir = opencode_dir / "plugins"
        plugin_dir.mkdir(parents=True, exist_ok=True)

        for source_path, filename, event_name in plugins_to_copy:
            shutil.copy(source_path, plugin_dir / filename)
            self.log.info(event_name)

    async def start_code_server(self) -> None:
        """Start code-server for browser-based VS Code editing."""
        password = os.environ.get("CODE_SERVER_PASSWORD")
        if not password:
            self.log.info("code_server.skip", reason="no_password")
            return

        # Use repo path if cloned, otherwise /workspace
        workdir = self.workspace_path
        if self.repo_path.exists() and (self.repo_path / ".git").exists():
            workdir = self.repo_path

        self.code_server_process = await asyncio.create_subprocess_exec(
            "code-server",
            "--bind-addr",
            f"0.0.0.0:{CODE_SERVER_PORT}",
            "--auth",
            "password",
            "--disable-telemetry",
            str(workdir),
            cwd=workdir,
            env={**os.environ, "PASSWORD": password},
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )

        asyncio.create_task(self._forward_code_server_logs())
        self.log.info("code_server.started", port=CODE_SERVER_PORT)

    async def _forward_code_server_logs(self) -> None:
        """Forward code-server stdout to supervisor stdout."""
        if not self.code_server_process or not self.code_server_process.stdout:
            return

        try:
            async for line in self.code_server_process.stdout:
                self.log.info("code_server.stdout", line=line.decode().rstrip())
        except Exception as e:
            self.log.warn("code_server.log_forward_error", exc=e)

    def _resolve_mcp_servers(self) -> list[dict]:
        """Resolve MCP servers from session config."""
        return self.session_config.get("mcp_servers") or []

    # Validates npm package names before passing to `npm install -g`.
    # Accepts: "package", "@scope/package", "package@1.0.0", "@scope/package@1.0.0"
    # Rejects anything with shell metacharacters or path traversal sequences.
    # NOTE: if a legitimate package is rejected, widen this regex rather than
    # removing the check — the package name comes from user-supplied config.
    _NPM_PKG_RE = re.compile(r"^(@[\w.-]+/)?[\w][\w.-]*(@[\w.-]+)?$")

    async def _install_mcp_packages(self, servers: list[dict]) -> None:
        """Pre-install npm packages for local MCP servers that use npx."""
        packages: list[str] = []
        for server in servers:
            if server.get("type") == "remote":
                continue
            cmd = server.get("command", [])
            if not cmd:
                continue
            parts = [c for c in cmd if isinstance(c, str)]
            if not parts or parts[0] != "npx":
                continue
            # Extract package name: prefer -p/--package flag, else first non-flag arg
            pkg: str | None = None
            for i, part in enumerate(parts):
                if part in ("-p", "--package") and i + 1 < len(parts):
                    pkg = parts[i + 1]
                    break
            if pkg is None:
                non_flags = [p for p in parts[1:] if not p.startswith("-")]
                pkg = non_flags[0] if non_flags else None

            if pkg:
                if self._NPM_PKG_RE.match(pkg):
                    packages.append(pkg)
                else:
                    self.log.warn(
                        "mcp.invalid_package_name",
                        package=pkg,
                        note="package skipped — npx will attempt download at runtime",
                    )

        packages = list(dict.fromkeys(packages))  # deduplicate, preserve order
        if not packages:
            return

        self.log.info("mcp.install_packages", packages=packages)
        try:
            proc = await asyncio.create_subprocess_exec(
                "npm",
                "install",
                "-g",
                *packages,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=self.MCP_PACKAGE_INSTALL_TIMEOUT_SECONDS
            )
            if proc.returncode == 0:
                self.log.info("mcp.packages_installed", packages=packages)
            else:
                self.log.warn(
                    "mcp.packages_install_failed",
                    packages=packages,
                    stderr=(stderr or b"").decode()[:500],
                )
        except TimeoutError:
            self.log.warn(
                "mcp.packages_install_timeout",
                packages=packages,
                timeout_seconds=self.MCP_PACKAGE_INSTALL_TIMEOUT_SECONDS,
            )
            proc.kill()
            await proc.wait()
        except Exception as e:
            self.log.warn("mcp.packages_install_error", packages=packages, exc=str(e))

    def _build_mcp_config(self, servers: list[dict]) -> dict[str, dict]:
        """Convert MCP server list to OpenCode mcp config format."""
        config: dict[str, dict] = {}
        for server in servers:
            name = server.get("name", "")
            if not name:
                continue
            if server.get("type") == "remote":
                entry: dict = {"type": "remote", "url": server.get("url", "")}
                auth_headers = server.get("headers") or server.get("env") or {}
                if auth_headers:
                    entry["headers"] = auth_headers
                config[name] = entry
            else:
                entry = {
                    "type": "local",
                    "command": server.get("command", []),
                }
                if server.get("env"):
                    entry["environment"] = server["env"]
                config[name] = entry
        return config

    async def start_ttyd(self) -> None:
        """Start ttyd web terminal if TERMINAL_ENABLED is set."""
        if not os.environ.get("TERMINAL_ENABLED"):
            self.log.info("ttyd.skip", reason="TERMINAL_ENABLED not set")
            return

        workdir = (
            str(self.repo_path)
            if self.repo_path and (self.repo_path / ".git").exists()
            else "/workspace"
        )

        cmd = [
            "ttyd",
            "--port",
            str(TTYD_PORT),
            "--interface",
            "127.0.0.1",  # localhost only — proxy is the only external gateway
            "--writable",
            "bash",
        ]

        self.log.info("ttyd.starting", port=TTYD_PORT, workdir=workdir)

        self.ttyd_process = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=workdir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=os.environ.copy(),
        )

        asyncio.create_task(self._forward_ttyd_logs())
        self.log.info("ttyd.started", pid=self.ttyd_process.pid)

    async def start_ttyd_proxy(self) -> None:
        """Start the JWT-authenticated reverse proxy in front of ttyd."""
        if not os.environ.get("TERMINAL_ENABLED"):
            return

        cmd = ["bun", "run", "/app/sandbox_runtime/ttyd_proxy/server.ts"]

        self.log.info("ttyd_proxy.starting", port=TTYD_PROXY_PORT)

        self.ttyd_proxy_process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=os.environ.copy(),
        )

        asyncio.create_task(self._forward_ttyd_proxy_logs())
        self.log.info("ttyd_proxy.started", pid=self.ttyd_proxy_process.pid)

    async def _forward_ttyd_logs(self) -> None:
        """Forward ttyd stdout to supervisor stdout."""
        if not self.ttyd_process or not self.ttyd_process.stdout:
            return

        try:
            async for line in self.ttyd_process.stdout:
                self.log.info("ttyd.stdout", line=line.decode().rstrip())
        except Exception as e:
            self.log.warn("ttyd.log_forward_error", exc=e)

    async def _forward_ttyd_proxy_logs(self) -> None:
        """Forward ttyd proxy stdout to supervisor stdout."""
        if not self.ttyd_proxy_process or not self.ttyd_proxy_process.stdout:
            return

        try:
            async for line in self.ttyd_proxy_process.stdout:
                self.log.info("ttyd_proxy.stdout", line=line.decode().rstrip())
        except Exception as e:
            self.log.warn("ttyd_proxy.log_forward_error", exc=e)

    async def _wait_for_port(self, port: int, timeout_seconds: float | None = None) -> bool:
        timeout_seconds = timeout_seconds or self.SIDECAR_TIMEOUT_SECONDS
        """Wait for a service to start listening on a port. Returns True if ready."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_seconds
        while loop.time() < deadline:
            try:
                _, writer = await asyncio.open_connection("127.0.0.1", port)
                writer.close()
                await writer.wait_closed()
                return True
            except (ConnectionRefusedError, OSError):
                await asyncio.sleep(0.1)
        self.log.warn("port_readiness.timeout", port=port, timeout=timeout_seconds)
        return False

    async def start_opencode(self) -> None:
        """Start OpenCode server with configuration."""
        self._setup_openai_oauth()
        self.log.info("opencode.start")

        # Build OpenCode config from session settings
        provider = self.session_config.get("provider", "anthropic")
        model = self.session_config.get("model", "claude-sonnet-4-6")
        opencode_config: dict = {
            "model": f"{provider}/{model}",
            "permission": {"*": {"*": "allow"}},
            # Enable LSP opportunistically. Useful only after the PR-head checkout fix
            # and when repo deps are installed; on a first-pass review against the
            # default branch it adds latency without semantic value.
            # Never used as a gate — diagnostics surface best-effort via edit/write output.
            # Only TS/JS gets a bundled server (typescript-language-server@5.3.0);
            # other languages depend on the target repo's own toolchain.
            "lsp": True,
        }

        # Apply user-supplied OpenCode config (deep-merged on top of system config)
        user_config_str = os.environ.get("OPENCODE_CONFIG_CONTENT")
        if user_config_str:
            try:
                user_config = json.loads(user_config_str)
                opencode_config = _deep_merge(opencode_config, user_config)
            except json.JSONDecodeError:
                self.log.warn(
                    "opencode.user_config_parse_error",
                    reason="Failed to parse OPENCODE_CONFIG_CONTENT, ignoring",
                )
        self._configure_langfuse(opencode_config)

        # Formal PR reviews must go through the `submit-pr-review` tool (which
        # routes to the control plane for a live policy check), never raw gh. This
        # best-effort deny rule stops the common documented command shapes early;
        # the authoritative block is the gh wrapper (git_credential_helper
        # `gh-guard`), which parses argv precisely. Merged AFTER the user config so
        # it can't be overridden. Patterns are kept specific to avoid false
        # positives on body text; the bare `-a`/`-r` shorthands are left to the
        # wrapper. The bash-level `"*": "allow"` keeps every other command allowed.
        opencode_config = _deep_merge(
            opencode_config,
            {
                "permission": {
                    "bash": {
                        "*pulls/*/reviews*event=APPROVE*": "deny",
                        "*pulls/*/reviews*event=REQUEST_CHANGES*": "deny",
                        "*pr review*--approve*": "deny",
                        "*pr review*--request-changes*": "deny",
                        "*": "allow",
                    }
                }
            },
        )

        # Inject MCP servers
        mcp_servers = self._resolve_mcp_servers()
        if mcp_servers:
            await self._install_mcp_packages(mcp_servers)
            mcp_config = self._build_mcp_config(mcp_servers)
            if mcp_config:
                opencode_config["mcp"] = mcp_config
                self.log.info("mcp.configured", count=len(mcp_config))

        # Determine working directory - use repo path if cloned, otherwise /workspace
        workdir = self.workspace_path
        if self.repo_path.exists() and (self.repo_path / ".git").exists():
            workdir = self.repo_path

        self._install_tools(workdir)
        self._install_skills(workdir)
        self._install_agents()
        self._install_bin_scripts()

        opencode_dir = workdir / ".opencode"
        self._deploy_opencode_plugins(opencode_dir)

        env = {
            **os.environ,
            "OPENCODE_CONFIG_CONTENT": json.dumps(opencode_config),
            # Disable OpenCode's question tool in headless mode. The tool blocks
            # on a Promise waiting for user input via the HTTP API, but the bridge
            # has no channel to relay questions to the web client and back. Without
            # this, the session hangs until the SSE inactivity timeout (120s).
            # See: https://github.com/anomalyco/opencode/blob/19b1222cd/packages/opencode/src/tool/registry.ts#L100
            "OPENCODE_CLIENT": "serve",
        }

        # Start OpenCode server in the repo directory
        self.opencode_process = await asyncio.create_subprocess_exec(
            "opencode",
            "serve",
            "--port",
            str(self.OPENCODE_PORT),
            "--hostname",
            "0.0.0.0",
            "--print-logs",  # Print logs to stdout for debugging
            cwd=workdir,  # Start in repo directory
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )

        # Start log forwarder
        asyncio.create_task(self._forward_opencode_logs())

        # Wait for health check
        await self._wait_for_health()
        self.opencode_ready.set()
        self.log.info("opencode.ready")

    def _configure_langfuse(self, opencode_config: dict) -> None:
        """Enable Langfuse OpenCode plugin when required credentials are present."""
        has_public_key = bool(os.environ.get("LANGFUSE_PUBLIC_KEY"))
        has_secret_key = bool(os.environ.get("LANGFUSE_SECRET_KEY"))

        if not (has_public_key and has_secret_key):
            if has_public_key or has_secret_key:
                self.log.warn(
                    "langfuse.config_incomplete",
                    has_public_key=has_public_key,
                    has_secret_key=has_secret_key,
                )
            return

        experimental = opencode_config.get("experimental")
        if isinstance(experimental, dict):
            experimental["openTelemetry"] = True
        else:
            opencode_config["experimental"] = {"openTelemetry": True}

        plugins = opencode_config.get("plugin")
        if isinstance(plugins, list):
            if self.LANGFUSE_PLUGIN_NAME not in plugins:
                plugins.append(self.LANGFUSE_PLUGIN_NAME)
        elif isinstance(plugins, str) and plugins:
            if plugins != self.LANGFUSE_PLUGIN_NAME:
                opencode_config["plugin"] = [plugins, self.LANGFUSE_PLUGIN_NAME]
        else:
            opencode_config["plugin"] = [self.LANGFUSE_PLUGIN_NAME]
        self.log.info("langfuse.plugin_enabled")

    async def _forward_opencode_logs(self) -> None:
        """Forward OpenCode stdout to supervisor stdout."""
        if not self.opencode_process or not self.opencode_process.stdout:
            return

        try:
            async for line in self.opencode_process.stdout:
                print(f"[opencode] {line.decode().rstrip()}")
        except Exception as e:
            print(f"[supervisor] Log forwarding error: {e}")

    async def _wait_for_health(self) -> None:
        """Poll health endpoint until server is ready."""
        health_url = f"http://localhost:{self.OPENCODE_PORT}/global/health"
        start_time = time.time()

        async with httpx.AsyncClient() as client:
            while time.time() - start_time < self.HEALTH_CHECK_TIMEOUT:
                if self.shutdown_event.is_set():
                    raise RuntimeError("Shutdown requested during startup")

                try:
                    resp = await client.get(health_url, timeout=2.0)
                    if resp.status_code == 200:
                        return
                except httpx.ConnectError:
                    pass
                except Exception as e:
                    self.log.debug("opencode.health_check_error", exc=e)

                await asyncio.sleep(0.5)

        raise RuntimeError("OpenCode server failed to become healthy")

    async def _prewarm_opencode_db(self) -> None:
        """Run OpenCode once at image-build time so its one-time SQLite
        migration ("Performing one time database migration, may take a few
        minutes") is baked into the snapshot.

        Without this the migration runs on the FIRST session boot from a freshly
        built image, blocking the bridge from connecting long enough that the
        control plane's 90s heartbeat watchdog kills the session before it is
        ever usable. Best-effort: any failure just defers the migration to first
        boot (the prior behaviour), so it never fails the image build.
        """
        self.log.info("opencode.prewarm_start")
        proc: asyncio.subprocess.Process | None = None
        drain_task: asyncio.Task[None] | None = None
        try:
            proc = await asyncio.create_subprocess_exec(
                "opencode",
                "serve",
                "--port",
                str(self.OPENCODE_PORT),
                "--hostname",
                "127.0.0.1",
                "--print-logs",
                cwd=self.workspace_path,
                env={**os.environ, "OPENCODE_CLIENT": "serve"},
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )

            async def _drain() -> None:
                assert proc is not None and proc.stdout is not None
                async for line in proc.stdout:
                    print(f"[opencode-prewarm] {line.decode().rstrip()}")

            drain_task = asyncio.create_task(_drain())

            # Health 200 means startup (incl. the DB migration) is complete.
            health_url = f"http://127.0.0.1:{self.OPENCODE_PORT}/global/health"
            deadline = time.time() + self.OPENCODE_PREWARM_TIMEOUT_SECONDS
            ready = False
            async with httpx.AsyncClient() as client:
                while time.time() < deadline:
                    # If opencode exited before serving (crash, port conflict,
                    # missing binary), stop immediately instead of polling for
                    # the full timeout — the migration just won't be baked this
                    # build (deferred to first boot, the prior behaviour).
                    if proc.returncode is not None:
                        self.log.warn("opencode.prewarm_exited_early", returncode=proc.returncode)
                        break
                    try:
                        resp = await client.get(health_url, timeout=2.0)
                        if resp.status_code == 200:
                            ready = True
                            break
                    except Exception:
                        pass
                    await asyncio.sleep(1.0)
            self.log.info("opencode.prewarm_complete", ready=ready)
        except Exception as e:
            self.log.warn("opencode.prewarm_failed", exc=e)
        finally:
            if drain_task is not None:
                drain_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await drain_task
            if proc is not None and proc.returncode is None:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=10)
                except TimeoutError:
                    with contextlib.suppress(ProcessLookupError):
                        proc.kill()

    async def start_bridge(self) -> None:
        """Start the agent bridge process."""
        self.log.info("bridge.start")

        if not self.control_plane_url:
            self.log.info("bridge.skip", reason="no_control_plane_url")
            return

        # Wait for OpenCode to be ready
        await self.opencode_ready.wait()

        # Get session_id from config (required for WebSocket connection)
        session_id = self.session_config.get("session_id", "")
        if not session_id:
            self.log.info("bridge.skip", reason="no_session_id")
            return

        # Run bridge as a module (works with relative imports)
        self.bridge_process = await asyncio.create_subprocess_exec(
            "python",
            "-m",
            "sandbox_runtime.bridge",
            "--sandbox-id",
            self.sandbox_id,
            "--session-id",
            session_id,
            "--control-plane",
            self.control_plane_url,
            "--token",
            self.sandbox_token,
            "--opencode-port",
            str(self.OPENCODE_PORT),
            env=os.environ,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )

        # Start log forwarder for bridge
        asyncio.create_task(self._forward_bridge_logs())
        self.log.info("bridge.started")

        # Check if bridge exited immediately during startup
        await asyncio.sleep(0.5)
        if self.bridge_process.returncode is not None:
            exit_code = self.bridge_process.returncode
            # Bridge exited immediately - read any error output
            stdout, _ = await self.bridge_process.communicate()
            if exit_code == 0:
                self.log.warn("bridge.early_exit", exit_code=exit_code)
            else:
                self.log.error(
                    "bridge.startup_crash",
                    exit_code=exit_code,
                    output=stdout.decode() if stdout else "",
                )

    async def _forward_bridge_logs(self) -> None:
        """Forward bridge stdout to supervisor stdout."""
        if not self.bridge_process or not self.bridge_process.stdout:
            return

        try:
            async for line in self.bridge_process.stdout:
                # Bridge already prefixes its output with [bridge], don't double it
                print(line.decode().rstrip())
        except Exception as e:
            print(f"[supervisor] Bridge log forwarding error: {e}")

    async def monitor_processes(self) -> None:
        """Monitor child processes and restart on crash."""
        restart_count = 0
        bridge_restart_count = 0
        code_server_restart_count = 0
        ttyd_restart_count = 0
        ttyd_proxy_restart_count = 0

        while not self.shutdown_event.is_set():
            # Check OpenCode process
            if self.opencode_process and self.opencode_process.returncode is not None:
                exit_code = self.opencode_process.returncode
                restart_count += 1

                self.log.error(
                    "opencode.crash",
                    exit_code=exit_code,
                    restart_count=restart_count,
                )

                if restart_count > self.MAX_RESTARTS:
                    self.log.error(
                        "opencode.max_restarts",
                        restart_count=restart_count,
                    )
                    await self._report_fatal_error(
                        f"OpenCode crashed {restart_count} times, giving up"
                    )
                    self.shutdown_event.set()
                    break

                # Exponential backoff
                delay = min(self.BACKOFF_BASE**restart_count, self.BACKOFF_MAX)
                self.log.info(
                    "opencode.restart",
                    delay_s=round(delay, 1),
                    restart_count=restart_count,
                )

                await asyncio.sleep(delay)
                self.opencode_ready.clear()
                await self.start_opencode()

            # Check bridge process
            if self.bridge_process and self.bridge_process.returncode is not None:
                exit_code = self.bridge_process.returncode

                if exit_code == 0:
                    # Graceful exit: shutdown command, session terminated, or fatal
                    # connection error. Propagate shutdown rather than restarting.
                    self.log.info(
                        "bridge.graceful_exit",
                        exit_code=exit_code,
                    )
                    self.shutdown_event.set()
                    break
                else:
                    # Crash: restart with backoff and retry limit
                    bridge_restart_count += 1
                    self.log.error(
                        "bridge.crash",
                        exit_code=exit_code,
                        restart_count=bridge_restart_count,
                    )

                    if bridge_restart_count > self.MAX_RESTARTS:
                        self.log.error(
                            "bridge.max_restarts",
                            restart_count=bridge_restart_count,
                        )
                        await self._report_fatal_error(
                            f"Bridge crashed {bridge_restart_count} times, giving up"
                        )
                        self.shutdown_event.set()
                        break

                    delay = min(self.BACKOFF_BASE**bridge_restart_count, self.BACKOFF_MAX)
                    self.log.info(
                        "bridge.restart",
                        delay_s=round(delay, 1),
                        restart_count=bridge_restart_count,
                    )
                    await asyncio.sleep(delay)
                    await self.start_bridge()

            # Check code-server process (non-fatal, best-effort restart)
            if self.code_server_process and self.code_server_process.returncode is not None:
                code_server_restart_count += 1
                self.log.warn(
                    "code_server.crash",
                    exit_code=self.code_server_process.returncode,
                    restart_count=code_server_restart_count,
                )

                if code_server_restart_count <= self.MAX_RESTARTS:
                    delay = min(self.BACKOFF_BASE**code_server_restart_count, self.BACKOFF_MAX)
                    await asyncio.sleep(delay)
                    try:
                        await self.start_code_server()
                    except Exception as e:
                        self.log.warn("code_server.restart_failed", exc=e)
                        self.code_server_process = None
                else:
                    self.log.warn(
                        "code_server.max_restarts", restart_count=code_server_restart_count
                    )
                    self.code_server_process = None

            # Check ttyd process (non-fatal, best-effort restart)
            if self.ttyd_process and self.ttyd_process.returncode is not None:
                ttyd_restart_count += 1
                self.log.warn(
                    "ttyd.crash",
                    exit_code=self.ttyd_process.returncode,
                    restart_count=ttyd_restart_count,
                )

                if ttyd_restart_count <= self.MAX_RESTARTS:
                    delay = min(self.BACKOFF_BASE**ttyd_restart_count, self.BACKOFF_MAX)
                    await asyncio.sleep(delay)
                    try:
                        await self.start_ttyd()
                    except Exception as e:
                        self.log.warn("ttyd.restart_failed", exc=e)
                        self.ttyd_process = None
                else:
                    self.log.warn("ttyd.max_restarts", restart_count=ttyd_restart_count)
                    self.ttyd_process = None

            # Check ttyd proxy process (non-fatal, best-effort restart)
            if self.ttyd_proxy_process and self.ttyd_proxy_process.returncode is not None:
                ttyd_proxy_restart_count += 1
                self.log.warn(
                    "ttyd_proxy.crash",
                    exit_code=self.ttyd_proxy_process.returncode,
                    restart_count=ttyd_proxy_restart_count,
                )

                if ttyd_proxy_restart_count <= self.MAX_RESTARTS:
                    delay = min(self.BACKOFF_BASE**ttyd_proxy_restart_count, self.BACKOFF_MAX)
                    await asyncio.sleep(delay)
                    try:
                        await self.start_ttyd_proxy()
                    except Exception as e:
                        self.log.warn("ttyd_proxy.restart_failed", exc=e)
                        self.ttyd_proxy_process = None
                else:
                    self.log.warn("ttyd_proxy.max_restarts", restart_count=ttyd_proxy_restart_count)
                    self.ttyd_proxy_process = None

            await asyncio.sleep(1.0)

    async def _report_fatal_error(self, message: str) -> None:
        """Report a fatal error to the control plane."""
        self.log.error("supervisor.fatal", error_message=message)

        if not self.control_plane_url:
            return

        try:
            async with httpx.AsyncClient() as client:
                await client.post(
                    f"{self.control_plane_url}/sandbox/{self.sandbox_id}/error",
                    json={"error": message, "fatal": True},
                    headers={"Authorization": f"Bearer {self.sandbox_token}"},
                    timeout=5.0,
                )
        except Exception as e:
            self.log.error("supervisor.report_error_failed", exc=e)

    async def _send_boot_progress(self) -> None:
        """Tell the control plane the sandbox is alive and still booting.

        Posted repeatedly during a long setup.sh — before the bridge WebSocket
        exists — so the connecting-timeout watchdog measures from the last ping
        rather than from sandbox creation. Best-effort: failures are logged at
        debug and never block boot.
        """
        if not self.control_plane_url or not self.session_id or not self.sandbox_token:
            return

        try:
            async with httpx.AsyncClient() as client:
                await client.post(
                    f"{self.control_plane_url}/sessions/{self.session_id}/boot-progress",
                    headers={"Authorization": f"Bearer {self.sandbox_token}"},
                    timeout=5.0,
                )
        except Exception as e:
            self.log.debug("boot_progress.send_failed", exc=e)

    async def _boot_progress_loop(self) -> None:
        """Ping the control plane every BOOT_PROGRESS_INTERVAL_SECONDS while the
        sandbox boots. Cancelled once the bridge starts, after which the bridge's
        own heartbeats keep the sandbox alive.
        """
        while not self.shutdown_event.is_set():
            await self._send_boot_progress()
            try:
                await asyncio.sleep(self.BOOT_PROGRESS_INTERVAL_SECONDS)
            except asyncio.CancelledError:
                break

    def _start_boot_progress_pings(self) -> None:
        """Start the background boot-progress ping loop (idempotent)."""
        if self._boot_progress_task is not None:
            return
        if not self.control_plane_url or not self.session_id:
            return
        self._boot_progress_task = asyncio.create_task(self._boot_progress_loop())

    async def _stop_boot_progress_pings(self) -> None:
        """Stop the boot-progress ping loop once the bridge has taken over."""
        task = self._boot_progress_task
        if task is None:
            return
        self._boot_progress_task = None
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    def _hook_env(self) -> dict[str, str]:
        """Build environment for startup hooks."""
        env = os.environ.copy()
        env["OPENINSPECT_BOOT_MODE"] = self.boot_mode
        # Use filesystem polling rather than inotify: Modal container kernels often
        # have low inotify watch limits, causing Next.js/webpack to miss file changes.
        # setdefault so repos can opt out by explicitly setting these to "false".
        env.setdefault("WATCHPACK_POLLING", "true")
        env.setdefault("CHOKIDAR_USEPOLLING", "true")
        return env

    def _persist_hook_env(self) -> None:
        """Write a shell-sourceable snapshot of the hook environment to SANDBOX_ENV_FILE_PATH.

        Merges the base hook env with any tunnel URLs already present in
        TUNNEL_ENV_FILE_PATH, then writes the result as `export KEY='value'`
        lines.  Agents can `source /workspace/.env.sandbox` before restarting
        a service to recover sandbox-injected vars (tunnel URLs, repo secrets,
        polling flags) that would otherwise be lost in a fresh shell.
        """
        import shlex

        env = self._hook_env()

        tunnel_path = Path(TUNNEL_ENV_FILE_PATH)
        if tunnel_path.exists():
            try:
                for line in tunnel_path.read_text().splitlines():
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        key, _, value = line.partition("=")
                        env[key.strip()] = value.strip()
            except Exception as e:
                self.log.warn("sandbox_env.tunnel_read_failed", path=str(tunnel_path), exc=e)

        sandbox_env_path = Path(SANDBOX_ENV_FILE_PATH)
        try:
            lines = [f"export {key}={shlex.quote(value)}" for key, value in sorted(env.items())]
            sandbox_env_path.write_text("\n".join(lines) + "\n")
            self.log.info(
                "sandbox_env.persisted",
                path=str(sandbox_env_path),
                count=len(env),
            )
        except Exception as e:
            self.log.warn("sandbox_env.persist_failed", path=str(sandbox_env_path), exc=e)

    async def _run_hook(
        self,
        *,
        hook_name: str,
        relative_script_path: str,
        timeout_env_var: str,
        default_timeout_seconds: int,
    ) -> bool:
        """
        Run a repo hook script if present.

        Returns:
            True if script succeeded or was not present, False on failure/timeout.
        """
        script_path = self.repo_path / relative_script_path
        start_time = time.time()

        if not script_path.exists():
            self.log.debug(
                f"{hook_name}.skip",
                reason="no_script",
                path=str(script_path),
                boot_mode=self.boot_mode,
            )
            return True

        try:
            timeout_seconds = int(os.environ.get(timeout_env_var, str(default_timeout_seconds)))
        except ValueError:
            timeout_seconds = default_timeout_seconds

        self.log.info(
            f"{hook_name}.start",
            script=str(script_path),
            timeout_seconds=timeout_seconds,
            boot_mode=self.boot_mode,
        )

        try:
            process = await asyncio.create_subprocess_exec(
                "bash",
                str(script_path),
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env=self._hook_env(),
                # Put the hook in its own process group so that killing it on
                # timeout also reaps background children (e.g. dev servers started
                # by start.sh that would otherwise keep the pipe write-end open,
                # causing process.stdout.read() to block indefinitely).
                start_new_session=True,
            )

            try:
                stdout, _ = await asyncio.wait_for(process.communicate(), timeout=timeout_seconds)
            except TimeoutError:
                # Kill the entire process group, not just bash. Background
                # processes spawned by the hook inherit the pipe's write fd; if
                # only bash is killed they keep the pipe open and any subsequent
                # read() blocks forever.
                try:
                    os.killpg(os.getpgid(process.pid), signal.SIGKILL)
                except OSError:
                    # Process or group already gone, or insufficient permissions
                    # (e.g. restricted test environments). Fall back to killing
                    # just the process itself.
                    process.kill()
                # Do NOT read from process.stdout here — orphaned children may
                # still hold the write end open. We have no usable data anyway
                # since communicate() was cancelled.
                stdout = b""
                await process.wait()
                output_tail = "\n".join(stdout.decode(errors="replace").splitlines()[-50:])
                duration_ms = int((time.time() - start_time) * 1000)
                self.log.error(
                    f"{hook_name}.timeout",
                    timeout_seconds=timeout_seconds,
                    output_tail=output_tail,
                    script=str(script_path),
                    duration_ms=duration_ms,
                    boot_mode=self.boot_mode,
                )
                return False

            output_tail = "\n".join(
                (stdout.decode(errors="replace") if stdout else "").splitlines()[-50:]
            )
            duration_ms = int((time.time() - start_time) * 1000)

            if process.returncode == 0:
                # Avoid logging hook stdout at info level to reduce secret exposure risk.
                self.log.info(
                    f"{hook_name}.complete",
                    exit_code=0,
                    script=str(script_path),
                    duration_ms=duration_ms,
                    boot_mode=self.boot_mode,
                )
                return True

            self.log.error(
                f"{hook_name}.failed",
                exit_code=process.returncode,
                output_tail=output_tail,
                script=str(script_path),
                duration_ms=duration_ms,
                boot_mode=self.boot_mode,
            )
            return False

        except Exception as e:
            duration_ms = int((time.time() - start_time) * 1000)
            self.log.error(
                f"{hook_name}.error",
                exc=e,
                script=str(script_path),
                duration_ms=duration_ms,
                boot_mode=self.boot_mode,
            )
            return False

    async def run_setup_script(self) -> bool:
        """
        Run scripts/.openinspect/setup.sh if it exists in the cloned repo.

        Fresh-session failures are non-fatal. Build mode callers may treat
        failures as fatal.

        Returns:
            True if script succeeded or was not present, False on failure/timeout.
        """
        return await self._run_hook(
            hook_name="setup",
            relative_script_path=self.SETUP_SCRIPT_PATH,
            timeout_env_var="SETUP_TIMEOUT_SECONDS",
            default_timeout_seconds=self.DEFAULT_SETUP_TIMEOUT_SECONDS,
        )

    async def run_start_script(self) -> bool:
        """
        Run scripts/.openinspect/start.sh if it exists in the repository.

        Returns:
            True if script succeeded or was not present, False on failure/timeout.
        """
        return await self._run_hook(
            hook_name="start",
            relative_script_path=self.START_SCRIPT_PATH,
            timeout_env_var="START_TIMEOUT_SECONDS",
            default_timeout_seconds=self.DEFAULT_START_TIMEOUT_SECONDS,
        )

    async def _start_dockerd_if_present(self) -> None:
        """
        Run Modal Docker-in-Sandboxes dockerd (see enable_docker + /start-dockerd.sh in the image).
        No-op if the script is missing (e.g. local test environments).
        """
        if not (
            Path("/start-dockerd.sh").is_file()
            and os.access("/start-dockerd.sh", os.X_OK, follow_symlinks=True)
        ):
            return
        self.log.info("dockerd.starting")
        self.dockerd_process = await asyncio.create_subprocess_exec(
            "/start-dockerd.sh",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        for _ in range(30):
            await asyncio.sleep(0.5)
            info = await asyncio.create_subprocess_exec(
                "docker",
                "info",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await info.wait()
            if info.returncode == 0:
                self.log.info("dockerd.ready")
                return
        self.log.warn("dockerd.unavailable", detail="docker info did not succeed within 30s")

    def _expected_tunnel_ports(self) -> list[int]:
        """Parse EXPECTED_TUNNEL_PORTS env var into a list of port ints."""
        raw = os.environ.get(EXPECTED_TUNNEL_PORTS_ENV_VAR, "")
        if not raw:
            return []
        ports: list[int] = []
        for piece in raw.split(","):
            piece = piece.strip()
            if not piece:
                continue
            try:
                ports.append(int(piece))
            except ValueError:
                self.log.warn("tunnel.expected_ports_parse_failed", value=piece, raw=raw)
        return ports

    def _clear_stale_tunnel_env_file(self) -> None:
        """Remove any pre-existing tunnel env file inherited from a snapshot."""
        path = Path(TUNNEL_ENV_FILE_PATH)
        try:
            path.unlink(missing_ok=True)
            self.log.info("tunnel.stale_file_cleared", path=str(path))
        except Exception as e:
            self.log.warn("tunnel.stale_file_clear_failed", path=str(path), exc=e)

    async def _wait_for_tunnel_env_file(self, expected_ports: list[int]) -> bool:
        """Block until TUNNEL_ENV_FILE_PATH contains entries for all expected ports.

        On timeout, log and return False so start.sh proceeds with degraded data
        rather than hanging on a Modal-side outage.
        """
        if not expected_ports:
            return True

        timeout_seconds_raw = os.environ.get("TUNNEL_WAIT_TIMEOUT_SECONDS")
        try:
            timeout_seconds = (
                float(timeout_seconds_raw)
                if timeout_seconds_raw
                else self.DEFAULT_TUNNEL_WAIT_TIMEOUT_SECONDS
            )
        except ValueError:
            timeout_seconds = self.DEFAULT_TUNNEL_WAIT_TIMEOUT_SECONDS

        path = Path(TUNNEL_ENV_FILE_PATH)
        expected_prefixes = [f"TUNNEL_{p}=" for p in expected_ports]
        start_time = time.time()
        deadline = start_time + timeout_seconds

        while time.time() < deadline:
            if path.exists():
                try:
                    lines = path.read_text().splitlines()
                    if all(any(ln.startswith(pfx) for ln in lines) for pfx in expected_prefixes):
                        self.log.info(
                            "tunnel.env_file_ready",
                            path=str(path),
                            ports=expected_ports,
                            wait_ms=int((time.time() - start_time) * 1000),
                        )
                        return True
                except Exception as e:
                    self.log.warn("tunnel.env_file_read_failed", path=str(path), exc=e)
            await asyncio.sleep(self.TUNNEL_WAIT_POLL_INTERVAL_SECONDS)

        self.log.warn(
            "tunnel.env_file_wait_timeout",
            path=str(path),
            ports=expected_ports,
            timeout_seconds=timeout_seconds,
        )
        return False

    async def run(self) -> None:
        """Main supervisor loop."""
        startup_start = time.time()

        self.log.info(
            "supervisor.start",
            repo_owner=self.repo_owner,
            repo_name=self.repo_name,
        )

        # Detect operating mode
        image_build_mode = os.environ.get("IMAGE_BUILD_MODE") == "true"
        restored_from_snapshot = os.environ.get("RESTORED_FROM_SNAPSHOT") == "true"
        from_repo_image = os.environ.get("FROM_REPO_IMAGE") == "true"

        if image_build_mode:
            self.boot_mode = "build"
        elif restored_from_snapshot:
            self.boot_mode = "snapshot_restore"
        elif from_repo_image:
            self.boot_mode = "repo_image"
        else:
            self.boot_mode = "fresh"

        # Expose boot mode to repo hooks and child processes.
        os.environ["OPENINSPECT_BOOT_MODE"] = self.boot_mode

        # Write AWS credentials before any user code runs (hooks, setup, OpenCode).
        self._setup_aws_credentials()
        # Configure kubectl kubeconfig from EKS cluster env vars (no-op if not set).
        self._setup_eks_kubeconfig()

        if image_build_mode:
            self.log.info("supervisor.image_build_mode")
        elif restored_from_snapshot:
            self.log.info("supervisor.restored_from_snapshot")
        elif from_repo_image:
            repo_image_sha = os.environ.get("REPO_IMAGE_SHA", "unknown")
            self.log.info("supervisor.from_repo_image", build_sha=repo_image_sha)
        repo_image_callback = (
            RepoImageBuildCallback.from_env(self.log) if image_build_mode else None
        )

        # Clear stale tunnel file on every restore: a snapshot taken with
        # tunnels configured retains the previous session's URLs even if this
        # session has no tunnel ports.
        expected_tunnel_ports = self._expected_tunnel_ports()
        if restored_from_snapshot or expected_tunnel_ports:
            self._clear_stale_tunnel_env_file()

        # Set up signal handlers
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, lambda s=sig: asyncio.create_task(self._handle_signal(s)))

        # Keep the control plane's connecting-timeout watchdog at bay during a
        # long setup.sh by pinging it from the start of boot. Stopped once the
        # bridge connects (Phase 5) and its heartbeats take over.
        if not image_build_mode:
            self._start_boot_progress_pings()

        git_sync_success = False
        head_sha = ""
        opencode_ready = False
        try:
            # Phase 0: Make sure the git credential helper is configured
            # before any git operation. New images do this in /etc/gitconfig,
            # but snapshots/repo-images built before this migration won't.
            await self._ensure_credential_helper_configured()

            # Phase 1: Git sync
            if restored_from_snapshot:
                git_sync_success = await self._update_existing_repo()
                if not git_sync_success:
                    self.log.warn(
                        "git.snapshot_resync_failed",
                        reason="origin rewrite or fetch failed; repo may be stale",
                    )
            elif from_repo_image:
                git_sync_success = await self._update_existing_repo()
            else:
                git_sync_success = await self.perform_git_sync()
            if image_build_mode and git_sync_success:
                head_sha = await self._get_head_sha()
                if head_sha:
                    self.log.info("git.sync_complete", head_sha=head_sha)
            self.git_sync_complete.set()

            # Phase 2: Run setup script only for fresh or build boots.
            setup_success: bool | None = None
            if self.boot_mode in ("fresh", "build"):
                setup_success = await self.run_setup_script()
                if image_build_mode and not setup_success:
                    raise RuntimeError("setup hook failed in build mode")

            # Phase 3: Run runtime start hook for all non-build boots. Wait for
            # tunnel URLs first so dev servers booted by start.sh see fresh data.
            start_success: bool | None = None
            if self.boot_mode != "build":
                await self._wait_for_tunnel_env_file(expected_tunnel_ports)
                # Persist the full hook environment (tunnel URLs + repo secrets +
                # polling flags) so agents can `source /workspace/.env.sandbox`
                # when restarting services without losing sandbox configuration.
                self._persist_hook_env()
                start_success = await self.run_start_script()
                if not start_success:
                    raise RuntimeError("start hook failed")
            else:
                start_success = None

            # Image build mode: signal completion then keep sandbox alive for
            # snapshot_filesystem(). MCP packages are not pre-installed during
            # builds — they are installed at first use via npx at session start.
            if image_build_mode:
                # Bake OpenCode's one-time SQLite migration into the image so
                # sessions don't pay it on first boot (it otherwise blocks the
                # bridge long enough to trip the 90s heartbeat watchdog).
                await self._prewarm_opencode_db()

                duration_ms = int((time.time() - startup_start) * 1000)
                self.log.info("image_build.complete", duration_ms=duration_ms)
                if repo_image_callback:
                    reported = await repo_image_callback.report_success(
                        base_sha=head_sha,
                        build_duration_seconds=time.time() - startup_start,
                    )
                    if not reported:
                        raise RuntimeError("repo image build-complete callback failed")
                await self.shutdown_event.wait()
                return

            # Phase 3.5: Start optional sidecars (best-effort, non-fatal)
            for sidecar_name, starter in (
                ("code_server", self.start_code_server),
                ("ttyd", self.start_ttyd),
            ):
                try:
                    await starter()
                except Exception as e:
                    self.log.warn(f"{sidecar_name}.start_failed", exc=e)

            if self.ttyd_process is not None:
                ttyd_ready = await self._wait_for_port(
                    TTYD_PORT, timeout_seconds=self.SIDECAR_TIMEOUT_SECONDS
                )
                if ttyd_ready:
                    try:
                        await self.start_ttyd_proxy()
                    except Exception as e:
                        self.log.warn("ttyd_proxy.start_failed", exc=e)

            # Phase 4: Start OpenCode server (in repo directory)
            await self.start_opencode()
            opencode_ready = True

            # Phase 5: Start bridge (after OpenCode is ready)
            await self.start_bridge()
            # The bridge now owns heartbeating; stop the boot-progress pings.
            await self._stop_boot_progress_pings()

            # Emit sandbox.startup wide event
            duration_ms = int((time.time() - startup_start) * 1000)
            self.log.info(
                "sandbox.startup",
                repo_owner=self.repo_owner,
                repo_name=self.repo_name,
                boot_mode=self.boot_mode,
                restored_from_snapshot=restored_from_snapshot,
                from_repo_image=from_repo_image,
                git_sync_success=git_sync_success,
                setup_success=setup_success,
                start_success=start_success,
                opencode_ready=opencode_ready,
                duration_ms=duration_ms,
                outcome="success",
            )

            # Phase 6: Monitor processes
            await self.monitor_processes()

        except Exception as e:
            self.log.error("supervisor.error", exc=e)
            if image_build_mode and repo_image_callback:
                await repo_image_callback.report_failure(str(e))
            await self._report_fatal_error(str(e))

        finally:
            await self.shutdown()

    async def _handle_signal(self, sig: signal.Signals) -> None:
        """Handle shutdown signal."""
        self.log.info("supervisor.signal", signal_name=sig.name)
        self.shutdown_event.set()

    async def shutdown(self) -> None:
        """Graceful shutdown of all processes."""
        self.log.info("supervisor.shutdown_start")

        # Stop boot-progress pings if boot failed before the bridge took over.
        await self._stop_boot_progress_pings()

        # Terminate bridge first
        if self.bridge_process and self.bridge_process.returncode is None:
            self.bridge_process.terminate()
            try:
                await asyncio.wait_for(self.bridge_process.wait(), timeout=5.0)
            except TimeoutError:
                self.bridge_process.kill()

        # Terminate code-server
        if self.code_server_process and self.code_server_process.returncode is None:
            self.code_server_process.terminate()
            try:
                await asyncio.wait_for(self.code_server_process.wait(), timeout=5.0)
            except TimeoutError:
                self.code_server_process.kill()

        # Terminate ttyd proxy first (it depends on ttyd)
        if self.ttyd_proxy_process and self.ttyd_proxy_process.returncode is None:
            self.log.info("ttyd_proxy.terminating")
            self.ttyd_proxy_process.terminate()
            try:
                await asyncio.wait_for(
                    self.ttyd_proxy_process.wait(), timeout=self.SIDECAR_TIMEOUT_SECONDS
                )
            except TimeoutError:
                self.ttyd_proxy_process.kill()

        # Terminate ttyd
        if self.ttyd_process and self.ttyd_process.returncode is None:
            self.log.info("ttyd.terminating")
            self.ttyd_process.terminate()
            try:
                await asyncio.wait_for(
                    self.ttyd_process.wait(), timeout=self.SIDECAR_TIMEOUT_SECONDS
                )
            except TimeoutError:
                self.ttyd_process.kill()

        # Terminate OpenCode
        if self.opencode_process and self.opencode_process.returncode is None:
            self.opencode_process.terminate()
            try:
                await asyncio.wait_for(self.opencode_process.wait(), timeout=10.0)
            except TimeoutError:
                self.opencode_process.kill()

        self.log.info("supervisor.shutdown_complete")


async def main():
    """Entry point for the sandbox supervisor."""
    supervisor = SandboxSupervisor()
    await supervisor.run()


if __name__ == "__main__":
    asyncio.run(main())
