"""Shell-level tests for the gh CLI wrapper.

The wrapper (`GH_WRAPPER_BODY`) is a thin /bin/sh delegator that does two things
in order:
  1. runs the credential helper's `gh-guard` action; if it exits 3 (blocked by
     the PR-review policy) the wrapper exits 3 and never runs gh;
  2. otherwise asks the `gh-token` action for a token and, if one is printed,
     exports it as GH_TOKEN before exec'ing the real gh.

The decisions themselves live in Python (see ``test_gh_guard.py`` for the guard
and ``test_git_credential_helper.py`` for token precedence); these tests only
verify the shell wiring — that a block short-circuits before gh runs, that a
printed token reaches gh via the environment (never argv), and that an empty or
failed helper falls through to whatever was already in the env.

We rebuild the wrapper here with the real gh and both helper invocations
pointed at fakes so the actual control flow runs under a real shell.
"""

from __future__ import annotations

import os
import subprocess
from typing import TYPE_CHECKING

from sandbox_runtime.entrypoint import GH_WRAPPER_BODY

if TYPE_CHECKING:
    from pathlib import Path

# Fake "real gh": echoes the token env vars and argv so a test can see which
# token (if any) the wrapper handed to gh and confirm it never hit argv. A test
# asserts the ABSENCE of this output to prove gh was never reached (blocked).
REAL_GH_DECISION = (
    '#!/bin/sh\necho "GH_TOKEN=${GH_TOKEN}"\necho "GITHUB_TOKEN=${GITHUB_TOKEN}"\n'
    'echo "GITHUB_APP_TOKEN=${GITHUB_APP_TOKEN}"\necho "ARGS=$*"\n'
)

# Fake `gh-token` helper behaviours.
PRINTS_FRESH_TOKEN = "#!/bin/sh\nprintf '%s' 'ghs_fresh'\n"
PRINTS_NOTHING = "#!/bin/sh\nexit 0\n"
EXITS_NONZERO = "#!/bin/sh\nexit 1\n"

# Fake `gh-guard` behaviours. ALLOWS exits 0 (proceed); BLOCKS mimics the real
# guard — writes a message to stderr and exits 3.
GUARD_ALLOWS = "#!/bin/sh\nexit 0\n"
GUARD_BLOCKS = "#!/bin/sh\necho 'BLOCKED by policy' >&2\nexit 3\n"

# Anchors we substitute in GH_WRAPPER_BODY to point at the fakes. Asserted
# present before use so that a drift in the wrapper body fails loudly here
# instead of silently leaving the test running the real gh / helper.
REAL_GH_ANCHOR = 'REAL_GH="/usr/bin/gh"'
GUARD_ANCHOR = "python3 -m sandbox_runtime.credentials.git_credential_helper gh-guard"
TOKEN_ANCHOR = "python3 -m sandbox_runtime.credentials.git_credential_helper gh-token"


def _build_wrapper(
    tmp_path: Path,
    *,
    token_cmd_body: str,
    guard_cmd_body: str = GUARD_ALLOWS,
) -> Path:
    """Materialize the wrapper with fakes for the real gh, guard, and token helper."""
    real_gh = tmp_path / "real-gh"
    real_gh.write_text(REAL_GH_DECISION)
    real_gh.chmod(0o755)

    guard_cmd = tmp_path / "guard-cmd"
    guard_cmd.write_text(guard_cmd_body)
    guard_cmd.chmod(0o755)

    token_cmd = tmp_path / "token-cmd"
    token_cmd.write_text(token_cmd_body)
    token_cmd.chmod(0o755)

    assert REAL_GH_ANCHOR in GH_WRAPPER_BODY
    assert GUARD_ANCHOR in GH_WRAPPER_BODY
    assert TOKEN_ANCHOR in GH_WRAPPER_BODY
    body = GH_WRAPPER_BODY.replace(REAL_GH_ANCHOR, f'REAL_GH="{real_gh}"')
    # Substitute the guard before the token: GUARD_ANCHOR and TOKEN_ANCHOR share
    # the same module prefix but differ in the trailing action word, so each
    # replace targets exactly one line.
    body = body.replace(GUARD_ANCHOR, str(guard_cmd))
    body = body.replace(TOKEN_ANCHOR, str(token_cmd))

    wrapper = tmp_path / "gh"
    wrapper.write_text(body)
    wrapper.chmod(0o755)
    return wrapper


def _run(
    wrapper: Path,
    env_extra: dict[str, str],
    *,
    args: tuple[str, ...] = ("api", "user"),
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    env = {"PATH": os.environ["PATH"], **env_extra}
    return subprocess.run(
        [str(wrapper), *args],
        capture_output=True,
        text=True,
        env=env,
        check=check,
    )


def test_exports_minted_token_as_gh_token(tmp_path: Path) -> None:
    wrapper = _build_wrapper(tmp_path, token_cmd_body=PRINTS_FRESH_TOKEN)
    out = _run(wrapper, {"VCS_HOST": "github.com"}).stdout
    assert "GH_TOKEN=ghs_fresh" in out
    assert "ARGS=api user" in out


def test_minted_token_never_reaches_argv(tmp_path: Path) -> None:
    """P1-2: the token must reach gh via the environment, never via argv."""
    wrapper = _build_wrapper(tmp_path, token_cmd_body=PRINTS_FRESH_TOKEN)
    out = _run(wrapper, {"VCS_HOST": "github.com"}).stdout
    args_line = next(line for line in out.splitlines() if line.startswith("ARGS="))
    assert "ghs_fresh" not in args_line


def test_no_export_when_helper_prints_nothing(tmp_path: Path) -> None:
    """Helper declined to mint → gh runs with the pre-existing env untouched."""
    wrapper = _build_wrapper(tmp_path, token_cmd_body=PRINTS_NOTHING)
    out = _run(wrapper, {"VCS_HOST": "github.com", "GITHUB_TOKEN": "user_token"}).stdout
    assert "GH_TOKEN=\n" in out
    assert "GITHUB_TOKEN=user_token" in out


def test_falls_through_when_helper_fails(tmp_path: Path) -> None:
    """A nonzero helper (swallowed by `|| true`) leaves the existing env for gh."""
    wrapper = _build_wrapper(tmp_path, token_cmd_body=EXITS_NONZERO)
    out = _run(wrapper, {"VCS_HOST": "github.com", "GITHUB_TOKEN": "stale_token"}).stdout
    assert "GH_TOKEN=\n" in out
    assert "GITHUB_TOKEN=stale_token" in out


def test_blocked_guard_exits_3_and_never_runs_gh(tmp_path: Path) -> None:
    """When the guard blocks, the wrapper exits 3 and gh is never exec'd."""
    wrapper = _build_wrapper(
        tmp_path, token_cmd_body=PRINTS_FRESH_TOKEN, guard_cmd_body=GUARD_BLOCKS
    )
    result = _run(
        wrapper,
        {"VCS_HOST": "github.com"},
        args=("api", "repos/o/r/pulls/5/reviews", "-f", "event=REQUEST_CHANGES"),
        check=False,
    )
    assert result.returncode == 3
    # The fake real-gh prints ARGS=…; its absence proves gh was never reached.
    assert "ARGS=" not in result.stdout
    assert "BLOCKED by policy" in result.stderr


def test_allowed_guard_proceeds_to_gh(tmp_path: Path) -> None:
    """When the guard allows, the wrapper mints a token and exec's gh as usual."""
    wrapper = _build_wrapper(
        tmp_path, token_cmd_body=PRINTS_FRESH_TOKEN, guard_cmd_body=GUARD_ALLOWS
    )
    out = _run(
        wrapper,
        {"VCS_HOST": "github.com"},
        args=("api", "repos/o/r/pulls/5/comments", "-f", "body=x"),
    ).stdout
    assert "GH_TOKEN=ghs_fresh" in out
    assert "ARGS=api repos/o/r/pulls/5/comments -f body=x" in out
