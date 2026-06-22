"""Tests for Modal build-repo-image API request assembly (timeout wiring)."""

from types import SimpleNamespace

import pytest

from src import web_api
from src.sandbox.manager import DEFAULT_BUILD_TIMEOUT_SECONDS


def _patch_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(web_api, "require_auth", lambda _authorization: None)


def _patch_build_repo_image(monkeypatch: pytest.MonkeyPatch, captured: dict) -> None:
    """Stub build_repo_image so we can capture .spawn.aio(**kwargs).

    The endpoint must call spawn directly — modal 1.3.1's Function has no
    .with_options, so the stub deliberately omits it; if the endpoint reaches
    for .with_options again the AttributeError fails the test.
    """

    async def fake_aio(**kwargs):
        captured["spawn_kwargs"] = kwargs
        return SimpleNamespace(object_id="fc-1")

    monkeypatch.setattr(
        "src.scheduler.image_builder.build_repo_image",
        SimpleNamespace(spawn=SimpleNamespace(aio=fake_aio)),
    )


async def _call_build(request: dict) -> dict:
    return await web_api.api_build_img.get_raw_f()(
        request,
        authorization="Bearer test",
        x_trace_id=None,
        x_request_id=None,
    )


def test_build_endpoint_name_matches_control_plane_label():
    """The endpoint MUST be named `api_build_img`.

    The function name drives the Modal web-endpoint label, and the control
    plane calls it at `${baseUrl}-api-build-img.modal.run`
    (packages/control-plane/src/sandbox/client.ts → buildRepoImageUrl). The
    longer upstream name `api_build_repo_image` yields a different (and, in long
    workspaces, hash-truncated) label, so the control plane's hard-coded URL
    404s and repo-image rebuilds silently stop. This guard fails loudly if a
    future upstream merge renames it back.
    """
    assert hasattr(web_api, "api_build_img")
    assert not hasattr(web_api, "api_build_repo_image")


@pytest.mark.asyncio
async def test_build_passes_requested_timeout_to_sandbox(monkeypatch):
    """The requested build timeout is forwarded to the worker (→ build sandbox lifetime)."""
    captured = {}
    _patch_auth(monkeypatch)
    _patch_build_repo_image(monkeypatch, captured)

    result = await _call_build(
        {
            "repo_owner": "acme",
            "repo_name": "repo",
            "default_branch": "main",
            "build_id": "img-1",
            "callback_url": "https://cp.test/repo-images/build-complete",
            "build_timeout_seconds": 2400,
        }
    )

    assert result["success"] is True
    assert captured["spawn_kwargs"]["build_timeout_seconds"] == 2400


@pytest.mark.asyncio
async def test_build_defaults_timeout_when_absent(monkeypatch):
    """A missing build_timeout_seconds falls back to the default everywhere."""
    captured = {}
    _patch_auth(monkeypatch)
    _patch_build_repo_image(monkeypatch, captured)

    result = await _call_build(
        {
            "repo_owner": "acme",
            "repo_name": "repo",
            "default_branch": "main",
            "build_id": "img-1",
            "callback_url": "https://cp.test/repo-images/build-complete",
        }
    )

    assert result["success"] is True
    assert captured["spawn_kwargs"]["build_timeout_seconds"] == DEFAULT_BUILD_TIMEOUT_SECONDS


@pytest.mark.asyncio
async def test_build_requires_core_fields(monkeypatch):
    """Validation still rejects missing identifiers before spawning."""
    captured = {}
    _patch_auth(monkeypatch)
    _patch_build_repo_image(monkeypatch, captured)

    with pytest.raises(web_api.HTTPException) as exc_info:
        await _call_build(
            {
                "repo_name": "repo",
                "default_branch": "main",
                "build_id": "img-1",
                "callback_url": "https://cp.test/repo-images/build-complete",
            }
        )

    assert exc_info.value.status_code == 400
    assert "spawn_kwargs" not in captured
