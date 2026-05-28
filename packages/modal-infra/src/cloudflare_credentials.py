"""
Cloudflare Access credential helper for Open-Inspect sandboxes.

Uses a permanent Cloudflare Access Service Token to obtain a short-lived
CF_Authorization JWT on each sandbox launch. The JWT (not the service token)
is what the sandbox uses for MCP portal requests — so the long-lived credentials
never reach the sandbox.

One-time setup:
  1. In Cloudflare Zero Trust → Access → Service Auth, create a Service Token
     for the MCP portal application.
  2. Create a Modal Secret named "cloudflare-access" containing:
       CF_ACCESS_CLIENT_ID      — Service token Client ID
       CF_ACCESS_CLIENT_SECRET  — Service token Client Secret
       CF_ACCESS_TOKEN_URL      — URL to exchange the service token for a JWT
                                  (typically the Cloudflare Access-protected app URL,
                                  e.g. "https://ftn-mcp.fountain.com/mcp")
  3. In the MCP server config sent from the control plane, set
     cloudflare_access=True on any remote server that needs this credential.
"""

from __future__ import annotations

import os

import httpx

from .log_config import get_logger

log = get_logger("cloudflare_credentials")


def get_cf_authorization_jwt() -> str | None:
    """
    Exchange Cloudflare Access Service Token credentials for a short-lived JWT.

    Reads CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET, and CF_ACCESS_TOKEN_URL
    from environment (injected via the "cloudflare-access" Modal Secret). Makes a
    request to CF_ACCESS_TOKEN_URL with the service token headers; Cloudflare
    Access validates them and returns a CF_Authorization cookie containing a JWT
    the sandbox can use for subsequent MCP portal requests.

    Returns:
        CF_Authorization JWT string, or None if credentials are not configured
        (i.e. the env vars are absent — not an error condition).

    Raises:
        RuntimeError: If credentials are configured but the exchange fails.
    """
    client_id = os.environ.get("CF_ACCESS_CLIENT_ID")
    client_secret = os.environ.get("CF_ACCESS_CLIENT_SECRET")
    token_url = os.environ.get("CF_ACCESS_TOKEN_URL")

    if not client_id or not client_secret or not token_url:
        return None

    log.info("cloudflare.request", token_url=token_url)

    # Use streaming so we can read response headers (where Cloudflare sets the
    # CF_Authorization cookie) without waiting for the body. The /mcp endpoint
    # is an SSE stream that never closes, so httpx.get() would always time out.
    try:
        with httpx.stream(
            "GET",
            token_url,
            headers={
                "CF-Access-Client-Id": client_id,
                "CF-Access-Client-Secret": client_secret,
            },
            follow_redirects=True,
            timeout=10.0,
        ) as response:
            log.info(
                "cloudflare.response",
                status=response.status_code,
                redirected=len(response.history) > 0,
                redirect_count=len(response.history),
                cookie_names=list(response.cookies.keys()),
            )

            jwt = response.cookies.get("CF_Authorization")
    except httpx.HTTPError as e:
        raise RuntimeError(f"Cloudflare Access token exchange failed: {e}") from e

    if not jwt:
        raise RuntimeError(
            f"No CF_Authorization cookie in response from {token_url!r} "
            f"(HTTP {response.status_code}). "
            "Verify that the service token has access to this application."
        )

    log.info("cloudflare.jwt_obtained", token_url=token_url)
    return jwt
