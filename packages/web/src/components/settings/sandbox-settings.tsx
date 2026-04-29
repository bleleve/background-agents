"use client";

import { useRepos } from "@/hooks/use-repos";
import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ChevronDownIcon, CheckIcon, PlusIcon } from "@/components/ui/icons";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import useSWR from "swr";
import type { SandboxSettings, AwsRoleConfig } from "@open-inspect/shared";
import { MAX_TUNNEL_PORTS, MAX_AWS_ROLES } from "@open-inspect/shared";

const GLOBAL_SCOPE = "__global__";

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
  const apiUrl = isGlobal
    ? "/api/integration-settings/sandbox"
    : `/api/integration-settings/sandbox/repos/${owner}/${name}`;

  const { data, mutate, isLoading } = useSWR<GlobalSettingsResponse | RepoSettingsResponse>(
    apiUrl,
    fetcher
  );

  const currentPorts: number[] = isGlobal
    ? ((data as GlobalSettingsResponse)?.settings?.defaults?.tunnelPorts ?? [])
    : ((data as RepoSettingsResponse)?.settings?.tunnelPorts ?? []);

  const currentTerminalEnabled: boolean = isGlobal
    ? ((data as GlobalSettingsResponse)?.settings?.defaults?.terminalEnabled ?? false)
    : ((data as RepoSettingsResponse)?.settings?.terminalEnabled ?? false);

  const currentAwsRoles: AwsRoleConfig[] = isGlobal
    ? ((data as GlobalSettingsResponse)?.settings?.defaults?.awsRoles ?? [])
    : ((data as RepoSettingsResponse)?.settings?.awsRoles ?? []);

  const [portRows, setPortRows] = useState<string[] | null>(null);
  const [terminalEnabled, setTerminalEnabled] = useState<boolean | null>(null);
  const [awsRoleDrafts, setAwsRoleDrafts] = useState<AwsRoleDraft[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Resolve terminal toggle: local edit or server state
  const resolvedTerminalEnabled = terminalEnabled ?? currentTerminalEnabled;

  // Use server state unless user is editing
  const rows = portRows ?? currentPorts.map(String);

  // Use server state for AWS roles unless user is editing
  const roleDrafts: AwsRoleDraft[] =
    awsRoleDrafts ??
    currentAwsRoles.map((r) => ({ profileName: r.profileName, roleArn: r.roleArn }));

  const handleAddRow = () => {
    if (rows.length >= MAX_TUNNEL_PORTS) return;
    setPortRows([...rows, ""]);
  };

  const handleUpdateRow = (index: number, value: string) => {
    const updated = [...rows];
    updated[index] = value;
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

  /** Trim, filter empty, validate, parse to number, dedupe. */
  const normalizePorts = (input: string[]): { ports: number[]; invalid: string[] } => {
    const nonEmpty = input.filter((r) => r.trim() !== "");
    const invalid = nonEmpty.filter((r) => !isValidPort(r.trim()));
    const ports = [
      ...new Set(nonEmpty.filter((r) => isValidPort(r.trim())).map((r) => Number(r.trim()))),
    ];
    return { ports, invalid };
  };

  const handleSave = useCallback(async () => {
    setError(null);
    setSuccess(false);

    const { ports, invalid } = normalizePorts(rows);
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

    setSaving(true);
    try {
      const existingEnabledRepos = isGlobal
        ? (data as GlobalSettingsResponse)?.settings?.enabledRepos
        : undefined;
      const settingsPayload: SandboxSettings = {
        tunnelPorts: ports,
        terminalEnabled: resolvedTerminalEnabled,
        awsRoles: validRoles.length > 0 ? validRoles : undefined,
      };
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
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [rows, isGlobal, apiUrl, mutate, data, resolvedTerminalEnabled, roleDrafts]);

  const hasPortChanges =
    portRows !== null &&
    JSON.stringify(normalizePorts(portRows).ports) !== JSON.stringify(currentPorts);
  const hasTerminalChange = terminalEnabled !== null && terminalEnabled !== currentTerminalEnabled;
  const hasAwsRolesChange =
    awsRoleDrafts !== null &&
    JSON.stringify(awsRoleDrafts) !==
      JSON.stringify(
        currentAwsRoles.map((r) => ({ profileName: r.profileName, roleArn: r.roleArn }))
      );
  const hasChanges = hasPortChanges || hasTerminalChange || hasAwsRolesChange;

  if (isLoading) {
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
        </p>
        <div className="space-y-2 max-w-sm">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">No tunnel ports configured.</p>
          ) : (
            rows.map((value, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  type="text"
                  inputMode="numeric"
                  value={value}
                  onChange={(e) => handleUpdateRow(index, e.target.value)}
                  placeholder="e.g. 3000"
                  className="flex-1"
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
