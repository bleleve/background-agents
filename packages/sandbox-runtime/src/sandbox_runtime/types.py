"""Type definitions for sandbox operations."""

from enum import StrEnum
from typing import Any, TypedDict

from pydantic import BaseModel


class SandboxStatus(StrEnum):
    """Status of a sandbox instance."""

    PENDING = "pending"
    SPAWNING = "spawning"
    CONNECTING = "connecting"
    WARMING = "warming"
    SYNCING = "syncing"
    READY = "ready"
    RUNNING = "running"
    STALE = "stale"  # Heartbeat missed - sandbox may be unresponsive
    SNAPSHOTTING = "snapshotting"  # Taking filesystem snapshot
    STOPPED = "stopped"
    FAILED = "failed"


class GitSyncStatus(StrEnum):
    """Status of git synchronization."""

    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"


class SandboxEvent(BaseModel):
    """Loose schema for an event emitted from sandbox to control plane.

    NOTE: this is a permissive documentation shape, NOT the source of truth for
    the wire protocol. The bridge builds and sends event payloads as plain dicts
    with camelCase keys (e.g. `messageId`, `sandboxId`, `callId`) and a flat
    shape — see AgentBridge._send_event in bridge.py and the SandboxEvent union
    in @open-inspect/shared. Do not add per-event subclasses here expecting them
    to validate or build the real frames; they previously drifted (snake_case +
    nested `data`) from what the bridge actually sends and were removed.
    """

    type: str
    sandbox_id: str
    data: dict[str, Any] = {}
    timestamp: float


class GitUser(BaseModel):
    """Git user configuration for commit attribution."""

    name: str
    email: str


class McpServerConfig(TypedDict, total=False):
    """MCP server config entry. Mirrors the TypeScript McpServerConfig type."""

    id: str
    name: str
    type: str  # "local" | "remote"
    command: list[str]
    url: str
    env: dict[str, str]
    headers: dict[str, str]
    repoScopes: list[str] | None
    enabled: bool


class SessionConfig(BaseModel):
    """Configuration passed to sandbox for a session."""

    session_id: str
    repo_owner: str
    repo_name: str
    branch: str | None = None
    base_sha: str | None = None
    opencode_session_id: str | None = None
    provider: str = "anthropic"
    model: str = "claude-sonnet-4-6"
    mcp_servers: list[McpServerConfig] | None = None
