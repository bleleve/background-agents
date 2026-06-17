"""Tests for BRIDGE_PROMPT_MAX_DURATION env resolution.

Providers with a sandbox lifetime shorter than the built-in PROMPT_MAX_DURATION
(e.g. Vercel's 45-min cap) set BRIDGE_PROMPT_MAX_DURATION so the bridge
self-stops a long prompt before the provider hard-kills the sandbox. The env can
only SHORTEN the cap, never extend it.
"""

from sandbox_runtime.bridge import AgentBridge


def _make_bridge() -> AgentBridge:
    return AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )


def test_defaults_to_class_constant(monkeypatch):
    monkeypatch.delenv("BRIDGE_PROMPT_MAX_DURATION", raising=False)
    bridge = _make_bridge()
    assert bridge.prompt_max_duration == AgentBridge.PROMPT_MAX_DURATION


def test_env_can_shorten(monkeypatch):
    monkeypatch.setenv("BRIDGE_PROMPT_MAX_DURATION", "2580")  # 43 min (Vercel-ish)
    bridge = _make_bridge()
    assert bridge.prompt_max_duration == 2580.0


def test_env_cannot_extend_beyond_default(monkeypatch):
    monkeypatch.setenv("BRIDGE_PROMPT_MAX_DURATION", "999999")
    bridge = _make_bridge()
    assert bridge.prompt_max_duration == AgentBridge.PROMPT_MAX_DURATION


def test_env_below_floor_is_clamped(monkeypatch):
    monkeypatch.setenv("BRIDGE_PROMPT_MAX_DURATION", "10")
    bridge = _make_bridge()
    assert bridge.prompt_max_duration == 60.0
