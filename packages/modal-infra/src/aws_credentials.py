"""
AWS credential helper for Open-Inspect sandboxes.

Uses Modal's built-in OIDC identity token (MODAL_IDENTITY_TOKEN) to assume
one or more IAM roles via AWS STS AssumeRoleWithWebIdentity.  The resulting
short-lived credentials are formatted as an INI-style AWS credentials file
and returned as a string so that the sandbox manager can write it to
~/.aws/credentials inside each new sandbox.

Prerequisites (one-time AWS setup per role):
  1. Add Modal as a trusted OIDC provider in your AWS account.
     OIDC provider URL: https://oidc.modal.com
     Audience:         sts.amazonaws.com
  2. Create or update the IAM role's trust policy to allow
     AssumeRoleWithWebIdentity from your Modal workspace.

See: https://modal.com/docs/guide/oidc-integration
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import boto3
from botocore.exceptions import ClientError

from .log_config import get_logger

log = get_logger("aws_credentials")

# Default session duration for assumed roles (1 hour). STS minimum is 15 min,
# maximum depends on the role's MaxSessionDuration setting (default 1 h).
DEFAULT_SESSION_DURATION_SECONDS = 3600


@dataclass
class AwsRoleConfig:
    """A named IAM role to assume via OIDC."""

    profile_name: str
    """AWS credentials profile name (e.g. "default", "prod")."""

    role_arn: str
    """Full IAM role ARN (e.g. "arn:aws:iam::123456789012:role/my-role")."""


@dataclass
class AwsCredentials:
    """Short-lived AWS credentials for a single role."""

    profile_name: str
    access_key_id: str
    secret_access_key: str
    session_token: str
    expiration: str  # ISO-8601 string


def assume_role(
    role_config: AwsRoleConfig,
    oidc_token: str,
    session_duration_seconds: int = DEFAULT_SESSION_DURATION_SECONDS,
) -> AwsCredentials:
    """
    Assume an IAM role using a Modal OIDC identity token.

    Args:
        role_config: Role ARN and profile name.
        oidc_token: The MODAL_IDENTITY_TOKEN JWT.
        session_duration_seconds: Credential lifetime in seconds.

    Returns:
        Short-lived AWS credentials for the assumed role.

    Raises:
        RuntimeError: If STS returns an error or the token is missing.
    """
    sts = boto3.client("sts", region_name="us-east-1")

    session_name = f"open-inspect-{role_config.profile_name}"[:64]

    try:
        response: dict[str, Any] = sts.assume_role_with_web_identity(
            RoleArn=role_config.role_arn,
            RoleSessionName=session_name,
            WebIdentityToken=oidc_token,
            DurationSeconds=session_duration_seconds,
        )
    except ClientError as e:
        raise RuntimeError(
            f"Failed to assume role {role_config.role_arn!r} "
            f"for profile {role_config.profile_name!r}: {e}"
        ) from e

    creds = response["Credentials"]
    expiration = (
        creds["Expiration"].isoformat()
        if hasattr(creds["Expiration"], "isoformat")
        else str(creds["Expiration"])
    )

    log.info(
        "aws.assume_role",
        profile=role_config.profile_name,
        role_arn=role_config.role_arn,
        expiration=expiration,
    )

    return AwsCredentials(
        profile_name=role_config.profile_name,
        access_key_id=creds["AccessKeyId"],
        secret_access_key=creds["SecretAccessKey"],
        session_token=creds["SessionToken"],
        expiration=expiration,
    )


def build_credentials_file(credentials: list[AwsCredentials]) -> str:
    """
    Render a list of credentials as an INI-style ~/.aws/credentials file.

    Each entry uses the profile name from the AwsCredentials object.
    A profile named "default" is written as ``[default]``; all others as
    ``[profile-name]``.

    Args:
        credentials: Assumed-role credentials to include.

    Returns:
        Multi-profile INI string ready to write to ~/.aws/credentials.
    """
    sections: list[str] = []
    for cred in credentials:
        header = f"[{cred.profile_name}]"
        section = "\n".join(
            [
                header,
                f"aws_access_key_id = {cred.access_key_id}",
                f"aws_secret_access_key = {cred.secret_access_key}",
                f"aws_session_token = {cred.session_token}",
                f"# expires: {cred.expiration}",
            ]
        )
        sections.append(section)

    return "\n\n".join(sections) + "\n"


def assume_roles(
    role_configs: list[AwsRoleConfig],
    session_duration_seconds: int = DEFAULT_SESSION_DURATION_SECONDS,
) -> tuple[str, list[str]]:
    """
    Assume all configured IAM roles and return a credentials file string.

    Uses the MODAL_IDENTITY_TOKEN environment variable injected by Modal's
    OIDC integration.  Roles that fail to be assumed are skipped with a
    warning (so a single bad ARN doesn't break all other roles).

    Args:
        role_configs: List of roles to assume.
        session_duration_seconds: Credential lifetime in seconds.

    Returns:
        Tuple of (credentials_file_content, list_of_failed_profile_names).
        credentials_file_content is empty string if all roles failed.
    """
    oidc_token = os.environ.get("MODAL_IDENTITY_TOKEN")
    if not oidc_token:
        log.warn(
            "aws.oidc_token_missing",
            note="MODAL_IDENTITY_TOKEN not set; skipping AWS credential injection",
        )
        return "", [r.profile_name for r in role_configs]

    credentials: list[AwsCredentials] = []
    failed: list[str] = []

    for role_config in role_configs:
        try:
            creds = assume_role(role_config, oidc_token, session_duration_seconds)
            credentials.append(creds)
        except Exception as e:
            log.warn(
                "aws.assume_role_failed",
                profile=role_config.profile_name,
                role_arn=role_config.role_arn,
                error=str(e),
            )
            failed.append(role_config.profile_name)

    if not credentials:
        return "", failed

    return build_credentials_file(credentials), failed
