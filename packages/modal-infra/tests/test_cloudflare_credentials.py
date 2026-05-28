import httpx
import pytest

from src.cloudflare_credentials import get_cf_authorization_jwt


def test_get_cf_authorization_jwt_returns_none_without_config(monkeypatch):
    monkeypatch.delenv("CF_ACCESS_CLIENT_ID", raising=False)
    monkeypatch.delenv("CF_ACCESS_CLIENT_SECRET", raising=False)
    monkeypatch.delenv("CF_ACCESS_TOKEN_URL", raising=False)

    def fail_stream(*args, **kwargs):
        raise AssertionError("Cloudflare request should not run")

    monkeypatch.setattr("src.cloudflare_credentials.httpx.stream", fail_stream)

    assert get_cf_authorization_jwt() is None


def test_get_cf_authorization_jwt_converts_httpx_errors(monkeypatch):
    monkeypatch.setenv("CF_ACCESS_CLIENT_ID", "client-id")
    monkeypatch.setenv("CF_ACCESS_CLIENT_SECRET", "client-secret")
    monkeypatch.setenv("CF_ACCESS_TOKEN_URL", "https://mcp.example.com/mcp")

    def raise_timeout(*args, **kwargs):
        raise httpx.ReadTimeout("The read operation timed out")

    monkeypatch.setattr("src.cloudflare_credentials.httpx.stream", raise_timeout)

    with pytest.raises(RuntimeError, match="Cloudflare Access token exchange failed"):
        get_cf_authorization_jwt()
