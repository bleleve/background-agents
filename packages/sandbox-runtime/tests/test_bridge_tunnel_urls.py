"""Unit tests for the bridge's tunnel-URL re-reporting helper.

The bridge re-reads /workspace/.tunnels.env on (re)connect and includes the
parsed URLs in its `ready` event so the control plane can restore preview links
that a transient timeout may have cleared.
"""

from sandbox_runtime.bridge import AgentBridge

TUNNEL_PATH_ATTR = "sandbox_runtime.bridge.TUNNEL_ENV_FILE_PATH"


def _bridge() -> AgentBridge:
    return AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )


def test_parses_tunnel_env_file(tmp_path, monkeypatch):
    env_file = tmp_path / ".tunnels.env"
    env_file.write_text("TUNNEL_8990=https://abc.modal.host\nTUNNEL_3000=https://def.modal.host\n")
    monkeypatch.setattr(TUNNEL_PATH_ATTR, str(env_file))

    assert _bridge()._read_tunnel_urls() == {
        "8990": "https://abc.modal.host",
        "3000": "https://def.modal.host",
    }


def test_returns_empty_when_file_absent(tmp_path, monkeypatch):
    monkeypatch.setattr(TUNNEL_PATH_ATTR, str(tmp_path / "missing.env"))

    assert _bridge()._read_tunnel_urls() == {}


def test_ignores_malformed_and_non_tunnel_lines(tmp_path, monkeypatch):
    env_file = tmp_path / ".tunnels.env"
    env_file.write_text(
        "\n".join(
            [
                "TUNNEL_8990=https://abc.modal.host",
                "# a comment",
                "NOT_A_TUNNEL=https://nope",
                "TUNNEL_NO_EQUALS",
                "TUNNEL_=https://empty-port",
                "",
            ]
        )
    )
    monkeypatch.setattr(TUNNEL_PATH_ATTR, str(env_file))

    assert _bridge()._read_tunnel_urls() == {"8990": "https://abc.modal.host"}
