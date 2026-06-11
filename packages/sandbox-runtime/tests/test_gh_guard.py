"""Unit tests for the `gh-guard` formal-review block.

The guard (in ``git_credential_helper._gh_command_is_blocked``) is the
authoritative enforcement of Reef's comment-only review process: it parses the
argv passed to ``gh`` and blocks a formal review submission (event APPROVE or
REQUEST_CHANGES) when ``OI_ALLOW_FORMAL_REVIEW`` forbids it. Inline comments,
the verdict issue comment, GETs, and COMMENT-event reviews must always pass.

These cover the gh flag-spelling matrix directly against the pure function;
``test_gh_wrapper.py`` covers the shell wiring around it.
"""

from __future__ import annotations

import pytest

from sandbox_runtime.credentials.git_credential_helper import _gh_command_is_blocked

BLOCK_ENV = {"OI_ALLOW_FORMAL_REVIEW": "false"}

# Commands that must be ALLOWED even when the policy blocks formal reviews.
ALLOWED_WHEN_BLOCKED = [
    # Inline review comment (POST to the comments collection, not reviews).
    ["api", "repos/o/r/pulls/5/comments", "-f", "body=x"],
    # Verdict issue comment.
    ["api", "repos/o/r/issues/5/comments", "-f", "body=x"],
    # GET on the reviews collection (no fields, no method → GET).
    ["api", "repos/o/r/pulls/5/reviews"],
    ["api", "-X", "GET", "repos/o/r/pulls/5/reviews"],
    # GET a single review by id (path is /reviews/{id}, not the collection).
    ["api", "repos/o/r/pulls/5/reviews/99"],
    # COMMENT-event review is non-blocking and permitted.
    ["api", "repos/o/r/pulls/5/reviews", "-f", "event=COMMENT", "-f", "body=x"],
    # `gh pr review` with --comment / bare interactive.
    ["pr", "review", "5", "--comment", "-b", "x"],
    ["pr", "review", "5"],
    # Unrelated commands.
    ["pr", "list"],
    ["issue", "comment", "5", "-b", "x"],
    ["api", "repos/o/r/pulls/5"],
    [],
]

# Commands that must be BLOCKED when the policy forbids formal reviews. Covers
# every gh field-flag spelling, glued and spaced, explicit and implicit POST.
BLOCKED_WHEN_FORBIDDEN = [
    # Implicit POST (field present, no -X).
    ["api", "repos/o/r/pulls/5/reviews", "-f", "event=REQUEST_CHANGES", "-f", "body=x"],
    # Explicit -X POST.
    ["api", "-X", "POST", "repos/o/r/pulls/5/reviews", "-f", "event=APPROVE"],
    # Glued method and field.
    ["api", "repos/o/r/pulls/5/reviews", "-XPOST", "-fevent=APPROVE"],
    # -F (raw field), spaced.
    ["api", "repos/o/r/pulls/5/reviews", "-F", "event=REQUEST_CHANGES"],
    # --field long form, lowercase value (case-insensitive match).
    ["api", "repos/o/r/pulls/5/reviews", "--field", "event=approve"],
    # --raw-field glued (--raw-field=event=APPROVE).
    ["api", "/repos/o/r/pulls/5/reviews", "--raw-field=event=APPROVE"],
    # Full api.github.com URL form.
    ["api", "https://api.github.com/repos/o/r/pulls/5/reviews", "-f", "event=APPROVE"],
    # --method=POST glued.
    ["api", "--method=POST", "repos/o/r/pulls/5/reviews", "-f", "event=REQUEST_CHANGES"],
    # gh pr review shorthands and long flags.
    ["pr", "review", "5", "--approve"],
    ["pr", "review", "5", "-a"],
    ["pr", "review", "5", "--request-changes", "-b", "x"],
    ["pr", "review", "5", "-r", "-b", "x"],
    ["pr", "review", "--approve", "5"],
]


@pytest.mark.parametrize("args", ALLOWED_WHEN_BLOCKED)
def test_allowed_commands_pass_even_when_policy_blocks(args: list[str]) -> None:
    assert _gh_command_is_blocked(args, BLOCK_ENV) is False


@pytest.mark.parametrize("args", BLOCKED_WHEN_FORBIDDEN)
def test_formal_reviews_blocked_when_policy_forbids(args: list[str]) -> None:
    assert _gh_command_is_blocked(args, BLOCK_ENV) is True


@pytest.mark.parametrize("args", BLOCKED_WHEN_FORBIDDEN)
def test_nothing_blocked_when_policy_allows(args: list[str]) -> None:
    """OI_ALLOW_FORMAL_REVIEW=true → every formal review passes (current behavior)."""
    assert _gh_command_is_blocked(args, {"OI_ALLOW_FORMAL_REVIEW": "true"}) is False


@pytest.mark.parametrize("args", BLOCKED_WHEN_FORBIDDEN)
def test_nothing_blocked_when_ungoverned(args: list[str]) -> None:
    """Absent flag ⇒ session not governed ⇒ no enforcement (non-github-bot sessions)."""
    assert _gh_command_is_blocked(args, {}) is False


@pytest.mark.parametrize("raw", ["false", "FALSE", "False", "0", "no", ""])
def test_block_values_enforce(raw: str) -> None:
    args = ["api", "repos/o/r/pulls/5/reviews", "-f", "event=REQUEST_CHANGES"]
    assert _gh_command_is_blocked(args, {"OI_ALLOW_FORMAL_REVIEW": raw}) is True


@pytest.mark.parametrize("raw", ["true", "TRUE", "1", "yes", "anything"])
def test_allow_values_permit(raw: str) -> None:
    args = ["api", "repos/o/r/pulls/5/reviews", "-f", "event=REQUEST_CHANGES"]
    assert _gh_command_is_blocked(args, {"OI_ALLOW_FORMAL_REVIEW": raw}) is False


def test_event_from_file_is_out_of_scope() -> None:
    """`-F event=@file` reads the value from a file; not parsed → not blocked here
    (documented residual, covered by the control-plane backstop)."""
    args = ["api", "repos/o/r/pulls/5/reviews", "-F", "event=@evt.txt"]
    assert _gh_command_is_blocked(args, BLOCK_ENV) is False
