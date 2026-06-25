"""Shared test fixtures and utilities for sandbox-runtime tests."""

from typing import Any

import httpx
import pytest

# Runtime env vars that the supervisor and git credential helper read at
# call time. When the test suite runs *inside* an Open-Inspect sandbox these
# are set in the real process environment (e.g. FROM_REPO_IMAGE=true,
# VCS_CLONE_TOKEN=..., GITHUB_TOKEN=...). Tests use patch.dict(clear=False)
# and assume these are unset unless a test sets them explicitly, so an
# ambient value silently changes boot-mode routing and credential fallback
# decisions and breaks otherwise-correct tests. Strip them before every test
# so behavior matches a clean CI environment. Tests that need a value still
# set it themselves via monkeypatch/patch.dict.
_AMBIENT_RUNTIME_ENV_VARS = (
    "IMAGE_BUILD_MODE",
    "RESTORED_FROM_SNAPSHOT",
    "FROM_REPO_IMAGE",
    "REPO_IMAGE_SHA",
    "OPENINSPECT_BOOT_MODE",
    "VCS_HOST",
    "VCS_CLONE_TOKEN",
    "VCS_CLONE_USERNAME",
    "CONTROL_PLANE_URL",
    "SANDBOX_AUTH_TOKEN",
    "SESSION_CONFIG",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_APP_TOKEN",
    "OI_GITHUB_TOKEN_IS_FALLBACK",
)


@pytest.fixture(autouse=True)
def _isolate_ambient_runtime_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove ambient sandbox runtime env vars so tests are deterministic.

    Without this, running the suite inside an Open-Inspect sandbox leaks the
    sandbox's own boot-mode and credential env into tests that assume a clean
    environment.
    """
    for key in _AMBIENT_RUNTIME_ENV_VARS:
        monkeypatch.delenv(key, raising=False)


class MockResponse:
    """Mock HTTP response for testing."""

    def __init__(self, status_code: int, json_data: Any = None, text: str = ""):
        self.status_code = status_code
        self._json_data = json_data
        self.text = text
        self.content = text.encode() if text else b""

    def json(self) -> Any:
        return self._json_data

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"HTTP {self.status_code}",
                request=httpx.Request("GET", "http://test"),
                response=httpx.Response(self.status_code),
            )
