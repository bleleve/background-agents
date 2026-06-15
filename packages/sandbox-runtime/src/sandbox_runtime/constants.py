"""Shared constants for sandbox modules."""

CODE_SERVER_PORT = 8080
TTYD_PORT = 7681
TTYD_PROXY_PORT = 7680

# Dotenv file containing `TUNNEL_<port>=<url>` per line, consumed by local
# services via `--env-file` or direct read.
TUNNEL_ENV_FILE_PATH = "/workspace/.tunnels.env"

# Shell-sourceable snapshot of the full hook environment (os.environ + tunnel
# URLs + sandbox-specific overrides). Written before start.sh runs so that
# agents can `source /workspace/.env.sandbox` when restarting services and
# recover the same environment without losing tunnel URLs or repo secrets.
SANDBOX_ENV_FILE_PATH = "/workspace/.env.sandbox"

# Comma-separated tunnel ports the manager will resolve. Read by the entrypoint
# to gate stale-file cleanup and the wait-for-fresh-URLs before start.sh.
EXPECTED_TUNNEL_PORTS_ENV_VAR = "EXPECTED_TUNNEL_PORTS"
