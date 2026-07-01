"use client";

import { useRepos } from "@/hooks/use-repos";
import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ChevronDownIcon, CheckIcon, PlusIcon } from "@/components/ui/icons";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import useSWR from "swr";
import type { AwsRoleConfig, ConfiguredSandboxPort, SandboxSettings } from "@open-inspect/shared";
import {
  DEFAULT_BUILD_TIMEOUT_SECONDS,
  DEFAULT_CODE_SERVER_PORT,
  DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS,
  DEFAULT_MAX_TOTAL_CHILD_SESSIONS,
  DEFAULT_TERMINAL_PORT,
  findSandboxPortConflict,
  MAX_AWS_ROLES,
  MAX_BUILD_TIMEOUT_SECONDS,
  MAX_TUNNEL_PORT_LABEL_LENGTH,
  MAX_TUNNEL_PORTS,
} from "@open-inspect/shared";

const GLOBAL_SCOPE = "__global__";
type ResourceField = "cpuCores" | "memoryMib";

interface GlobalSettingsResponse {
  integrationId: string;
  settings: { defaults?: SandboxSettings; enabledRepos?: string[] } | null;
}

interface RepoSettingsResponse {
  integrationId: string;
  repo: string;
  settings: SandboxSettings | null;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function isValidPort(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535;
}

/** Validate a single AWS role entry draft. Returns error string or null. */
function validateAwsRoleDraft(draft: AwsRoleDraft): string | null {
  if (!draft.profileName.trim()) return "Profile name is required";
  if (!draft.roleArn.trim()) return "Role ARN is required";
  if (!draft.roleArn.trim().startsWith("arn:aws:iam::"))
    return 'Role ARN must start with "arn:aws:iam::"';
  return null;
}

interface AwsRoleDraft {
  profileName: string;
  roleArn: string;
}

/** One editable tunnel-port row: the port plus its optional display label. */
interface TunnelPortDraft {
  port: string;
  label: string;
}

/**
 * Normalize tunnel-port draft rows into the persisted shape. Trims and filters
 * empty ports, dedupes, collects invalid ports for error reporting, and builds a
 * port→label map from non-empty labels (capped at MAX_TUNNEL_PORT_LABEL_LENGTH,
 * keyed only to valid ports). Shared by save and change-detection.
 */
function normalizeTunnelRows(input: TunnelPortDraft[]): {
  ports: number[];
  labels: Record<string, string>;
  invalid: string[];
} {
  const seen = new Set<number>();
  const ports: number[] = [];
  const labels: Record<string, string> = {};
  const invalid: string[] = [];
  for (const row of input) {
    const port = row.port.trim();
    if (port === "") continue;
    if (!isValidPort(port)) {
      invalid.push(port);
      continue;
    }
    const num = Number(port);
    if (seen.has(num)) continue;
    seen.add(num);
    ports.push(num);
    const label = row.label.trim().slice(0, MAX_TUNNEL_PORT_LABEL_LENGTH);
    if (label !== "") labels[String(num)] = label;
  }
  return { ports, labels, invalid };
}

function isPositiveInteger(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) >= 1;
}

function isValidCpuCores(value: string): boolean {
  if (!/^\d*\.?\d+$/.test(value)) return false;
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function isValidMemoryMib(value: string): boolean {
  if (!/^\d+$/.test(value)) return false;
  return Number(value) >= 1;
}

function isValidBuildTimeout(value: string): boolean {
  if (!/^\d+$/.test(value)) return false;
  const n = Number(value);
  return n >= 1 && n <= MAX_BUILD_TIMEOUT_SECONDS;
}

const numOrUndef = (v: number | null | undefined): number | undefined =>
  typeof v === "number" ? v : undefined;

/** Value to show in the input: own repo override, else inherited global (display only). */
function resourceDisplayValue(
  isGlobal: boolean,
  globalDefaults: SandboxSettings | undefined,
  repoSettings: SandboxSettings | null | undefined,
  field: ResourceField
): number | undefined {
  if (!isGlobal) {
    const own = repoSettings?.[field];
    if (own !== undefined) return numOrUndef(own); // own override (null → blank)
  }
  return numOrUndef(globalDefaults?.[field]);
}

/**
 * The value to persist for a resource field, or `undefined` to omit it from the
 * payload (`null` means "use the provider default"). A stored JSON value is never
 * `undefined`, so returning `prior` directly preserves an existing override and
 * skips an inherited-only field in one move.
 */
function resourcePayloadValue(
  isGlobal: boolean,
  editState: string | null,
  trimmed: string,
  prior: number | null | undefined
): number | null | undefined {
  if (isGlobal) return trimmed === "" ? undefined : Number(trimmed);
  if (editState !== null) return trimmed === "" ? null : Number(trimmed);
  return prior; // not edited: keep existing override, or undefined → don't pin
}

function SandboxSettingsEditor({
  scope,
  owner,
  name,
}: {
  scope: "global" | "repo";
  owner?: string;
  name?: string;
}) {
  const isGlobal = scope === "global";
  const globalApiUrl = "/api/integration-settings/sandbox";
  const apiUrl = isGlobal
    ? globalApiUrl
    : `/api/integration-settings/sandbox/repos/${owner}/${name}`;

  const { data, mutate, isLoading } = useSWR<GlobalSettingsResponse | RepoSettingsResponse>(
    apiUrl,
    fetcher
  );
  const { data: globalData, isLoading: isLoadingGlobal } = useSWR<GlobalSettingsResponse>(
    isGlobal ? null : globalApiUrl,
    fetcher
  );

  const globalDefaults = isGlobal
    ? (data as GlobalSettingsResponse | undefined)?.settings?.defaults
    : globalData?.settings?.defaults;
  const repoSettings = isGlobal ? undefined : (data as RepoSettingsResponse | undefined)?.settings;

  const currentPorts: number[] = isGlobal
    ? ((data as GlobalSettingsResponse)?.settings?.defaults?.tunnelPorts ?? [])
    : ((data as RepoSettingsResponse)?.settings?.tunnelPorts ?? []);

  const currentTunnelPortLabels: Record<string, string> = isGlobal
    ? ((data as GlobalSettingsResponse)?.settings?.defaults?.tunnelPortLabels ?? {})
    : ((data as RepoSettingsResponse)?.settings?.tunnelPortLabels ?? {});

  const currentTerminalEnabled: boolean = isGlobal
    ? ((data as GlobalSettingsResponse)?.settings?.defaults?.terminalEnabled ?? false)
    : ((data as RepoSettingsResponse)?.settings?.terminalEnabled ?? false);

  const currentAwsRoles: AwsRoleConfig[] = isGlobal
    ? ((data as GlobalSettingsResponse)?.settings?.defaults?.awsRoles ?? [])
    : ((data as RepoSettingsResponse)?.settings?.awsRoles ?? []);

  const currentCodeServerPort: number | undefined = isGlobal
    ? (data as GlobalSettingsResponse)?.settings?.defaults?.codeServerPort
    : (data as RepoSettingsResponse)?.settings?.codeServerPort;

  const currentTerminalPort: number | undefined = isGlobal
    ? (data as GlobalSettingsResponse)?.settings?.defaults?.terminalPort
    : (data as RepoSettingsResponse)?.settings?.terminalPort;

  const currentBuildTimeoutSeconds: number | undefined = isGlobal
    ? (data as GlobalSettingsResponse)?.settings?.defaults?.buildTimeoutSeconds
    : (data as RepoSettingsResponse)?.settings?.buildTimeoutSeconds;

  const currentMaxConcurrentChildSessions: number = isGlobal
    ? (globalDefaults?.maxConcurrentChildSessions ?? DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS)
    : (repoSettings?.maxConcurrentChildSessions ??
      globalDefaults?.maxConcurrentChildSessions ??
      DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS);

  const currentMaxTotalChildSessions: number = isGlobal
    ? (globalDefaults?.maxTotalChildSessions ?? DEFAULT_MAX_TOTAL_CHILD_SESSIONS)
    : (repoSettings?.maxTotalChildSessions ??
      globalDefaults?.maxTotalChildSessions ??
      DEFAULT_MAX_TOTAL_CHILD_SESSIONS);

  const currentCpuCores = resourceDisplayValue(isGlobal, globalDefaults, repoSettings, "cpuCores");
  const currentMemoryMib = resourceDisplayValue(
    isGlobal,
    globalDefaults,
    repoSettings,
    "memoryMib"
  );

  const [portRows, setPortRows] = useState<TunnelPortDraft[] | null>(null);
  const [terminalEnabled, setTerminalEnabled] = useState<boolean | null>(null);
  const [awsRoleDrafts, setAwsRoleDrafts] = useState<AwsRoleDraft[] | null>(null);
  const [codeServerPort, setCodeServerPort] = useState<string | null>(null);
  const [terminalPort, setTerminalPort] = useState<string | null>(null);
  const [buildTimeoutSeconds, setBuildTimeoutSeconds] = useState<string | null>(null);
  const [maxConcurrentChildSessions, setMaxConcurrentChildSessions] = useState<string | null>(null);
  const [maxTotalChildSessions, setMaxTotalChildSessions] = useState<string | null>(null);
  const [cpuCores, setCpuCores] = useState<string | null>(null);
  const [memoryMib, setMemoryMib] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Resolve terminal toggle: local edit or server state
  const resolvedTerminalEnabled = terminalEnabled ?? currentTerminalEnabled;

  // Use server state unless user is editing
  const rows: TunnelPortDraft[] =
    portRows ??
    currentPorts.map((port) => ({
      port: String(port),
      label: currentTunnelPortLabels[String(port)] ?? "",
    }));
  const resolvedMaxConcurrentChildSessions =
    maxConcurrentChildSessions ?? String(currentMaxConcurrentChildSessions);
  const resolvedMaxTotalChildSessions =
    maxTotalChildSessions ?? String(currentMaxTotalChildSessions);
  const resolvedCpuCores =
    cpuCores ?? (currentCpuCores !== undefined ? String(currentCpuCores) : "");
  const resolvedMemoryMib =
    memoryMib ?? (currentMemoryMib !== undefined ? String(currentMemoryMib) : "");
  const resolvedCodeServerPort =
    codeServerPort ?? (currentCodeServerPort !== undefined ? String(currentCodeServerPort) : "");
  const resolvedTerminalPort =
    terminalPort ?? (currentTerminalPort !== undefined ? String(currentTerminalPort) : "");
  const resolvedBuildTimeoutSeconds =
    buildTimeoutSeconds ??
    (currentBuildTimeoutSeconds !== undefined ? String(currentBuildTimeoutSeconds) : "");

  // Use server state for AWS roles unless user is editing
  const roleDrafts: AwsRoleDraft[] =
    awsRoleDrafts ??
    currentAwsRoles.map((r) => ({ profileName: r.profileName, roleArn: r.roleArn }));

  const handleAddRow = () => {
    if (rows.length >= MAX_TUNNEL_PORTS) return;
    setPortRows([...rows, { port: "", label: "" }]);
  };

  const handleUpdateRow = (index: number, field: keyof TunnelPortDraft, value: string) => {
    const updated = [...rows];
    updated[index] = { ...updated[index], [field]: value };
    setPortRows(updated);
  };

  const handleRemoveRow = (index: number) => {
    const updated = rows.filter((_, i) => i !== index);
    setPortRows(updated);
  };

  const handleAddAwsRole = () => {
    if (roleDrafts.length >= MAX_AWS_ROLES) return;
    setAwsRoleDrafts([...roleDrafts, { profileName: "", roleArn: "" }]);
  };

  const handleUpdateAwsRole = (index: number, field: keyof AwsRoleDraft, value: string) => {
    const updated = [...roleDrafts];
    updated[index] = { ...updated[index], [field]: value };
    setAwsRoleDrafts(updated);
  };

  const handleRemoveAwsRole = (index: number) => {
    setAwsRoleDrafts(roleDrafts.filter((_, i) => i !== index));
  };

  const handleSave = useCallback(async () => {
    setError(null);
    setSuccess(false);

    const { ports, labels: tunnelPortLabels, invalid } = normalizeTunnelRows(rows);
    if (invalid.length > 0) {
      setError(`Invalid port numbers: ${invalid.join(", ")}`);
      return;
    }

    // Validate AWS roles
    for (const draft of roleDrafts) {
      // Skip entirely empty rows
      if (!draft.profileName.trim() && !draft.roleArn.trim()) continue;
      const err = validateAwsRoleDraft(draft);
      if (err) {
        setError(`AWS role error: ${err}`);
        return;
      }
    }
    const validRoles: AwsRoleConfig[] = roleDrafts
      .filter((d) => d.profileName.trim() && d.roleArn.trim())
      .map((d) => ({ profileName: d.profileName.trim(), roleArn: d.roleArn.trim() }));

    if (
      !isPositiveInteger(resolvedMaxConcurrentChildSessions) ||
      !isPositiveInteger(resolvedMaxTotalChildSessions)
    ) {
      setError("Child session limits must be positive whole numbers.");
      return;
    }
    if (Number(resolvedMaxConcurrentChildSessions) > Number(resolvedMaxTotalChildSessions)) {
      setError("Max concurrent child sessions cannot exceed max total child sessions.");
      return;
    }

    const trimmedCpu = resolvedCpuCores.trim();
    if (trimmedCpu !== "" && !isValidCpuCores(trimmedCpu)) {
      setError("CPU cores must be a positive number.");
      return;
    }

    const trimmedMemory = resolvedMemoryMib.trim();
    if (trimmedMemory !== "" && !isValidMemoryMib(trimmedMemory)) {
      setError("Memory must be a positive whole number of MiB.");
      return;
    }

    const trimmedCodeServerPort = resolvedCodeServerPort.trim();
    if (trimmedCodeServerPort !== "" && !isValidPort(trimmedCodeServerPort)) {
      setError("Code server port must be a whole number between 1 and 65535.");
      return;
    }

    const trimmedTerminalPort = resolvedTerminalPort.trim();
    if (trimmedTerminalPort !== "" && !isValidPort(trimmedTerminalPort)) {
      setError("Terminal port must be a whole number between 1 and 65535.");
      return;
    }

    const trimmedBuildTimeout = resolvedBuildTimeoutSeconds.trim();
    if (trimmedBuildTimeout !== "" && !isValidBuildTimeout(trimmedBuildTimeout)) {
      setError(
        `Build timeout must be a whole number of seconds, at most ${MAX_BUILD_TIMEOUT_SECONDS}.`
      );
      return;
    }

    // Validate against the EFFECTIVE service ports the runtime will bind: an
    // explicit value, else (at repo scope) the inherited global default, else the
    // shared default. A blank field still occupies its default port, so a tunnel
    // on 8080/7680 must be caught here just like an explicit collision.
    const effectiveCodeServerPort =
      trimmedCodeServerPort !== ""
        ? Number(trimmedCodeServerPort)
        : isGlobal
          ? DEFAULT_CODE_SERVER_PORT
          : (globalDefaults?.codeServerPort ?? DEFAULT_CODE_SERVER_PORT);
    const effectiveTerminalPort =
      trimmedTerminalPort !== ""
        ? Number(trimmedTerminalPort)
        : isGlobal
          ? DEFAULT_TERMINAL_PORT
          : (globalDefaults?.terminalPort ?? DEFAULT_TERMINAL_PORT);
    const configuredPorts: ConfiguredSandboxPort[] = [
      ...ports.map((port) => ({ port, label: "tunnel port" })),
      { port: effectiveCodeServerPort, label: "code server port" },
      { port: effectiveTerminalPort, label: "terminal port" },
    ];
    const portConflict = findSandboxPortConflict(configuredPorts);
    if (portConflict) {
      setError(
        portConflict.kind === "reserved"
          ? `Port ${portConflict.port} is reserved for the internal terminal and cannot be used.`
          : "Code server, terminal, and tunnel ports must all be different."
      );
      return;
    }

    setSaving(true);
    try {
      const existingEnabledRepos = isGlobal
        ? (data as GlobalSettingsResponse)?.settings?.enabledRepos
        : undefined;
      const settingsPayload: SandboxSettings = {
        tunnelPorts: ports,
        tunnelPortLabels: Object.keys(tunnelPortLabels).length > 0 ? tunnelPortLabels : undefined,
        terminalEnabled: resolvedTerminalEnabled,
        awsRoles: validRoles.length > 0 ? validRoles : undefined,
      };
      if (trimmedCodeServerPort !== "") {
        settingsPayload.codeServerPort = Number(trimmedCodeServerPort);
      }
      if (trimmedTerminalPort !== "") {
        settingsPayload.terminalPort = Number(trimmedTerminalPort);
      }
      if (trimmedBuildTimeout !== "") {
        settingsPayload.buildTimeoutSeconds = Number(trimmedBuildTimeout);
      }
      if (
        isGlobal ||
        maxConcurrentChildSessions !== null ||
        repoSettings?.maxConcurrentChildSessions !== undefined
      ) {
        settingsPayload.maxConcurrentChildSessions = Number(resolvedMaxConcurrentChildSessions);
      }
      if (
        isGlobal ||
        maxTotalChildSessions !== null ||
        repoSettings?.maxTotalChildSessions !== undefined
      ) {
        settingsPayload.maxTotalChildSessions = Number(resolvedMaxTotalChildSessions);
      }
      const cpu = resourcePayloadValue(isGlobal, cpuCores, trimmedCpu, repoSettings?.cpuCores);
      if (cpu !== undefined) settingsPayload.cpuCores = cpu;
      const memory = resourcePayloadValue(
        isGlobal,
        memoryMib,
        trimmedMemory,
        repoSettings?.memoryMib
      );
      if (memory !== undefined) settingsPayload.memoryMib = memory;
      const body = isGlobal
        ? { settings: { defaults: settingsPayload, enabledRepos: existingEnabledRepos } }
        : { settings: settingsPayload };

      const res = await fetch(apiUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Failed to save (${res.status})`);
      }

      await mutate();
      setPortRows(null);
      setTerminalEnabled(null);
      setAwsRoleDrafts(null);
      setMaxConcurrentChildSessions(null);
      setMaxTotalChildSessions(null);
      setCpuCores(null);
      setMemoryMib(null);
      setCodeServerPort(null);
      setTerminalPort(null);
      setBuildTimeoutSeconds(null);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [
    rows,
    isGlobal,
    apiUrl,
    mutate,
    data,
    resolvedTerminalEnabled,
    resolvedMaxConcurrentChildSessions,
    resolvedMaxTotalChildSessions,
    resolvedCpuCores,
    resolvedMemoryMib,
    resolvedCodeServerPort,
    resolvedTerminalPort,
    resolvedBuildTimeoutSeconds,
    cpuCores,
    memoryMib,
    maxConcurrentChildSessions,
    maxTotalChildSessions,
    repoSettings?.maxConcurrentChildSessions,
    repoSettings?.maxTotalChildSessions,
    roleDrafts,
    repoSettings?.cpuCores,
    repoSettings?.memoryMib,
    globalDefaults?.codeServerPort,
    globalDefaults?.terminalPort,
  ]);

  const editedTunnels = portRows !== null ? normalizeTunnelRows(portRows) : null;
  // Both sides run through normalizeTunnelRows so port/label key order aligns,
  // making the JSON comparison order-stable.
  const savedTunnels = normalizeTunnelRows(
    currentPorts.map((port) => ({
      port: String(port),
      label: currentTunnelPortLabels[String(port)] ?? "",
    }))
  );
  const hasPortChanges =
    editedTunnels !== null &&
    JSON.stringify({ ports: editedTunnels.ports, labels: editedTunnels.labels }) !==
      JSON.stringify({ ports: savedTunnels.ports, labels: savedTunnels.labels });
  const hasTerminalChange = terminalEnabled !== null && terminalEnabled !== currentTerminalEnabled;
  const hasAwsRolesChange =
    awsRoleDrafts !== null &&
    JSON.stringify(awsRoleDrafts) !==
      JSON.stringify(
        currentAwsRoles.map((r) => ({ profileName: r.profileName, roleArn: r.roleArn }))
      );
  const hasConcurrentLimitChange =
    maxConcurrentChildSessions !== null &&
    maxConcurrentChildSessions !== String(currentMaxConcurrentChildSessions);
  const hasTotalLimitChange =
    maxTotalChildSessions !== null &&
    maxTotalChildSessions !== String(currentMaxTotalChildSessions);
  const currentCpuCoresString = currentCpuCores !== undefined ? String(currentCpuCores) : "";
  const currentMemoryMibString = currentMemoryMib !== undefined ? String(currentMemoryMib) : "";
  const hasCpuChange = cpuCores !== null && cpuCores.trim() !== currentCpuCoresString;
  const hasMemoryChange = memoryMib !== null && memoryMib.trim() !== currentMemoryMibString;
  const currentCodeServerPortString =
    currentCodeServerPort !== undefined ? String(currentCodeServerPort) : "";
  const currentTerminalPortString =
    currentTerminalPort !== undefined ? String(currentTerminalPort) : "";
  const hasCodeServerPortChange =
    codeServerPort !== null && codeServerPort.trim() !== currentCodeServerPortString;
  const hasTerminalPortChange =
    terminalPort !== null && terminalPort.trim() !== currentTerminalPortString;
  const currentBuildTimeoutSecondsString =
    currentBuildTimeoutSeconds !== undefined ? String(currentBuildTimeoutSeconds) : "";
  const hasBuildTimeoutChange =
    buildTimeoutSeconds !== null && buildTimeoutSeconds.trim() !== currentBuildTimeoutSecondsString;
  const hasChanges =
    hasPortChanges ||
    hasTerminalChange ||
    hasAwsRolesChange ||
    hasConcurrentLimitChange ||
    hasTotalLimitChange ||
    hasCpuChange ||
    hasMemoryChange ||
    hasCodeServerPortChange ||
    hasTerminalPortChange ||
    hasBuildTimeoutChange;

  if (isLoading || isLoadingGlobal) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  return (
    <div className="space-y-4">
      {/* Web Terminal toggle */}
      <div className="max-w-sm">
        <div className="flex items-center justify-between">
          <div>
            <label className="block text-sm font-medium text-foreground">Web Terminal</label>
            <p className="text-xs text-muted-foreground">
              Enable a browser-based terminal in sandbox sessions.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={resolvedTerminalEnabled}
            onClick={() => setTerminalEnabled(!resolvedTerminalEnabled)}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
              resolvedTerminalEnabled ? "bg-accent" : "bg-muted"
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${
                resolvedTerminalEnabled ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">Service Ports</label>
        <p className="text-xs text-muted-foreground mb-2">
          Ports code-server and the web terminal bind to. Leave blank for the defaults (
          {DEFAULT_CODE_SERVER_PORT} and {DEFAULT_TERMINAL_PORT}). Change a port to free the default
          for your own service on a tunnel. Code-server is enabled in its own settings.
        </p>
        <div className="grid gap-3 max-w-sm sm:grid-cols-2">
          <div>
            <label
              htmlFor="code-server-port"
              className="block text-xs font-medium text-muted-foreground mb-1"
            >
              Code server port
            </label>
            <Input
              id="code-server-port"
              type="text"
              inputMode="numeric"
              value={resolvedCodeServerPort}
              onChange={(e) => setCodeServerPort(e.target.value)}
              placeholder={String(DEFAULT_CODE_SERVER_PORT)}
            />
          </div>
          <div>
            <label
              htmlFor="terminal-port"
              className="block text-xs font-medium text-muted-foreground mb-1"
            >
              Terminal port
            </label>
            <Input
              id="terminal-port"
              type="text"
              inputMode="numeric"
              value={resolvedTerminalPort}
              onChange={(e) => setTerminalPort(e.target.value)}
              placeholder={String(DEFAULT_TERMINAL_PORT)}
            />
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between max-w-sm mb-1.5">
          <label className="block text-sm font-medium text-foreground">Tunnel Ports</label>
          <Button
            type="button"
            variant="subtle"
            size="xs"
            onClick={handleAddRow}
            disabled={rows.length >= MAX_TUNNEL_PORTS}
            className="text-accent hover:text-accent/80"
          >
            <PlusIcon className="w-3 h-3" />
            Add port
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mb-2">
          Expose additional ports from sandboxes via public tunnel URLs (e.g., dev server ports).
          Add an optional label to name each preview link.
        </p>
        <div className="space-y-2 max-w-sm">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">No tunnel ports configured.</p>
          ) : (
            rows.map((row, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  type="text"
                  inputMode="numeric"
                  value={row.port}
                  onChange={(e) => handleUpdateRow(index, "port", e.target.value)}
                  placeholder="e.g. 3000"
                  className="w-24"
                  aria-label="Tunnel port"
                />
                <Input
                  type="text"
                  value={row.label}
                  onChange={(e) => handleUpdateRow(index, "label", e.target.value)}
                  placeholder="Label (optional)"
                  className="flex-1"
                  maxLength={MAX_TUNNEL_PORT_LABEL_LENGTH}
                  aria-label="Tunnel port label"
                />
                <Button
                  type="button"
                  variant="destructive"
                  size="xs"
                  onClick={() => handleRemoveRow(index)}
                >
                  Remove
                </Button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* AWS IAM Roles */}
      <div>
        <div className="flex items-center justify-between max-w-2xl mb-1.5">
          <label className="block text-sm font-medium text-foreground">AWS IAM Roles</label>
          <Button
            type="button"
            variant="subtle"
            size="xs"
            onClick={handleAddAwsRole}
            disabled={roleDrafts.length >= MAX_AWS_ROLES}
            className="text-accent hover:text-accent/80"
          >
            <PlusIcon className="w-3 h-3" />
            Add role
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mb-2">
          IAM roles to assume via Modal OIDC on each sandbox launch. Credentials are written to{" "}
          <code className="font-mono">~/.aws/credentials</code> in the sandbox.
        </p>
        <div className="space-y-3 max-w-2xl">
          {roleDrafts.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">No AWS roles configured.</p>
          ) : (
            roleDrafts.map((role, index) => (
              <div key={index} className="flex items-start gap-2">
                <div className="flex flex-col gap-1 flex-1 min-w-0">
                  <Input
                    type="text"
                    value={role.profileName}
                    onChange={(e) => handleUpdateAwsRole(index, "profileName", e.target.value)}
                    placeholder="Profile name (e.g. default, prod)"
                    className="w-full"
                    aria-label="AWS profile name"
                  />
                  <Input
                    type="text"
                    value={role.roleArn}
                    onChange={(e) => handleUpdateAwsRole(index, "roleArn", e.target.value)}
                    placeholder="arn:aws:iam::123456789012:role/my-role"
                    className="w-full font-mono text-xs"
                    aria-label="IAM role ARN"
                  />
                </div>
                <Button
                  type="button"
                  variant="destructive"
                  size="xs"
                  onClick={() => handleRemoveAwsRole(index)}
                  className="mt-1 flex-shrink-0"
                >
                  Remove
                </Button>
              </div>
            ))
          )}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">Child Sessions</label>
        <p className="text-xs text-muted-foreground mb-2">
          Limit agent-spawned child sessions to prevent runaway sandbox usage.
        </p>
        <div className="grid gap-3 max-w-sm sm:grid-cols-2">
          <div>
            <label
              htmlFor="max-concurrent-child-sessions"
              className="block text-xs font-medium text-muted-foreground mb-1"
            >
              Max concurrent child sessions
            </label>
            <Input
              id="max-concurrent-child-sessions"
              type="number"
              min="1"
              inputMode="numeric"
              value={resolvedMaxConcurrentChildSessions}
              onChange={(e) => setMaxConcurrentChildSessions(e.target.value)}
            />
          </div>
          <div>
            <label
              htmlFor="max-total-child-sessions"
              className="block text-xs font-medium text-muted-foreground mb-1"
            >
              Max total child sessions
            </label>
            <Input
              id="max-total-child-sessions"
              type="number"
              min="1"
              inputMode="numeric"
              value={resolvedMaxTotalChildSessions}
              onChange={(e) => setMaxTotalChildSessions(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">Resources</label>
        <p className="text-xs text-muted-foreground mb-2">
          Reserve CPU and memory for each sandbox. Leave blank to use the provider&apos;s default
          reservation.
        </p>
        <div className="grid gap-3 max-w-sm sm:grid-cols-2">
          <div>
            <label
              htmlFor="sandbox-cpu-cores"
              className="block text-xs font-medium text-muted-foreground mb-1"
            >
              CPU cores
            </label>
            <Input
              id="sandbox-cpu-cores"
              type="text"
              inputMode="decimal"
              value={resolvedCpuCores}
              onChange={(e) => setCpuCores(e.target.value)}
              placeholder="provider default"
            />
          </div>
          <div>
            <label
              htmlFor="sandbox-memory-mib"
              className="block text-xs font-medium text-muted-foreground mb-1"
            >
              Memory (MiB)
            </label>
            <Input
              id="sandbox-memory-mib"
              type="number"
              min={1}
              inputMode="numeric"
              value={resolvedMemoryMib}
              onChange={(e) => setMemoryMib(e.target.value)}
              placeholder="provider default"
            />
          </div>
        </div>
      </div>

      <div>
        <label
          htmlFor="sandbox-build-timeout"
          className="block text-sm font-medium text-foreground mb-1.5"
        >
          Repo Image Build Timeout
        </label>
        <p className="text-xs text-muted-foreground mb-2">
          How long a pre-built repo image may take to build (clone + setup), in seconds. Raise it
          for large repos with slow setup. Leave blank for the default (
          {DEFAULT_BUILD_TIMEOUT_SECONDS}s). Builds only — sessions are unaffected.
        </p>
        <div className="max-w-sm">
          <Input
            id="sandbox-build-timeout"
            type="number"
            min={1}
            max={MAX_BUILD_TIMEOUT_SECONDS}
            inputMode="numeric"
            value={resolvedBuildTimeoutSeconds}
            onChange={(e) => setBuildTimeoutSeconds(e.target.value)}
            placeholder={String(DEFAULT_BUILD_TIMEOUT_SECONDS)}
          />
          <p className="text-xs text-muted-foreground mt-1">
            Maximum: {MAX_BUILD_TIMEOUT_SECONDS} seconds.
          </p>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex items-center gap-2">
        <Button onClick={handleSave} disabled={saving || !hasChanges} size="sm">
          {saving ? "Saving..." : "Save Settings"}
        </Button>
        {success && <span className="text-sm text-success">Saved</span>}
      </div>
    </div>
  );
}

export function SandboxSettingsPage() {
  const { repos, loading: loadingRepos } = useRepos();
  const [selectedRepo, setSelectedRepo] = useState(GLOBAL_SCOPE);

  const selectedRepoObj = repos.find((r) => r.fullName === selectedRepo);
  const isGlobal = selectedRepo === GLOBAL_SCOPE;
  const displayRepoName = isGlobal
    ? "All Repositories (Global)"
    : selectedRepoObj
      ? selectedRepoObj.fullName
      : loadingRepos
        ? "Loading..."
        : "Select a repository";

  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-1">Sandbox</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Configure sandbox environment settings. Per-repo settings override global defaults.
      </p>

      {/* Repo selector */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-foreground mb-1.5">Repository</label>
        <Combobox
          value={selectedRepo}
          onChange={setSelectedRepo}
          items={repos.map((repo) => ({
            value: repo.fullName,
            label: repo.name,
            description: `${repo.owner}${repo.private ? " \u2022 private" : ""}`,
          }))}
          searchable
          searchPlaceholder="Search repositories..."
          filterFn={(option, query) =>
            option.label.toLowerCase().includes(query) ||
            (option.description?.toLowerCase().includes(query) ?? false) ||
            String(option.value).toLowerCase().includes(query)
          }
          direction="down"
          dropdownWidth="w-full max-w-sm"
          disabled={loadingRepos}
          triggerClassName="w-full max-w-sm flex items-center justify-between px-3 py-2 text-sm border border-border bg-input text-foreground hover:border-foreground/30 disabled:opacity-50 disabled:cursor-not-allowed transition"
          prependContent={({ select }) => (
            <>
              <button
                type="button"
                onClick={() => select(GLOBAL_SCOPE)}
                className={`w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-muted transition ${
                  isGlobal ? "text-foreground" : "text-muted-foreground"
                }`}
              >
                <div className="flex flex-col items-start text-left">
                  <span className="font-medium">All Repositories (Global)</span>
                  <span className="text-xs text-secondary-foreground">
                    Shared across all repositories
                  </span>
                </div>
                {isGlobal && <CheckIcon className="w-4 h-4 text-accent" />}
              </button>
              {repos.length > 0 && <div className="border-t border-border my-1" />}
            </>
          )}
        >
          <span className="truncate">{displayRepoName}</span>
          <ChevronDownIcon className="w-3 h-3 flex-shrink-0" />
        </Combobox>
      </div>

      {isGlobal ? (
        <SandboxSettingsEditor scope="global" />
      ) : selectedRepoObj ? (
        <SandboxSettingsEditor
          key={selectedRepoObj.fullName}
          scope="repo"
          owner={selectedRepoObj.owner}
          name={selectedRepoObj.name}
        />
      ) : null}
    </div>
  );
}
