"use client";

import { useState } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import { useRepos } from "@/hooks/use-repos";
import { ChevronDownIcon, CheckIcon } from "@/components/ui/icons";
import { Combobox } from "@/components/ui/combobox";

const GLOBAL_SCOPE = "__global__";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface ConfigResponse {
  config: string | null;
}

interface ConfigEditorProps {
  apiUrl: string;
  disabled?: boolean;
}

function ConfigEditor({ apiUrl, disabled = false }: ConfigEditorProps) {
  const { data, isLoading } = useSWR<ConfigResponse>(apiUrl, fetcher);
  const [localConfig, setLocalConfig] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [jsonError, setJsonError] = useState<string | null>(null);

  // Sync SWR data into local state once on initial load
  if (!initialized && data !== undefined) {
    setLocalConfig(data.config ?? "");
    setInitialized(true);
  }

  const configValue = initialized ? (localConfig ?? "") : (data?.config ?? "");

  const handleChange = (value: string) => {
    setLocalConfig(value);
    setJsonError(null);
  };

  const handleSave = async () => {
    const trimmed = configValue.trim();
    if (trimmed) {
      try {
        JSON.parse(trimmed);
      } catch {
        setJsonError("Invalid JSON — please fix before saving.");
        return;
      }
    }

    setSaving(true);
    setJsonError(null);

    try {
      const response = await fetch(apiUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: trimmed }),
      });

      if (response.ok) {
        toast.success("OpenCode config saved.");
        mutate(apiUrl);
        setInitialized(false);
      } else {
        const errorData = await response.json();
        toast.error(errorData?.error || "Failed to save config");
      }
    } catch {
      toast.error("Failed to save config");
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setClearing(true);
    setJsonError(null);

    try {
      const response = await fetch(apiUrl, { method: "DELETE" });

      if (response.ok || response.status === 204) {
        toast.success("OpenCode config cleared.");
        setLocalConfig("");
        setInitialized(false);
        mutate(apiUrl);
      } else {
        toast.error("Failed to clear config");
      }
    } catch {
      toast.error("Failed to clear config");
    } finally {
      setClearing(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        Loading config...
      </div>
    );
  }

  return (
    <div className="mt-4 border border-border bg-background p-4">
      <textarea
        className="w-full min-h-[200px] font-mono text-sm bg-input border border-border text-foreground p-3 resize-y focus:outline-none focus:border-foreground/30 transition disabled:opacity-50 disabled:cursor-not-allowed"
        placeholder={'{\n  "providers": {},\n  "tools": []\n}'}
        value={configValue}
        onChange={(e) => handleChange(e.target.value)}
        disabled={disabled || saving || clearing}
      />
      {jsonError && <p className="mt-1 text-xs text-red-500">{jsonError}</p>}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={disabled || saving || clearing}
          className="text-xs px-3 py-1 border border-border-muted text-foreground hover:border-foreground transition disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save"}
        </button>
        <button
          type="button"
          onClick={handleClear}
          disabled={disabled || saving || clearing}
          className="text-xs px-3 py-1 border border-border-muted text-muted-foreground hover:text-red-500 hover:border-red-300 transition disabled:opacity-50"
        >
          {clearing ? "Clearing..." : "Clear Config"}
        </button>
      </div>
    </div>
  );
}

export function OpenCodeConfigSettings() {
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
      <h2 className="text-xl font-semibold text-foreground mb-1">OpenCode Config</h2>
      <p className="text-sm text-muted-foreground mb-6">
        This JSON is merged with the system OpenCode config. Repository config overrides the global
        config. You can configure providers, tools, MCPs, and other OpenCode settings.
      </p>

      {/* Repo selector */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-foreground mb-1.5">Repository</label>
        <Combobox
          value={selectedRepo}
          onChange={setSelectedRepo}
          items={repos.map((repo) => ({
            value: repo.fullName,
            label: repo.name,
            description: `${repo.owner}${repo.private ? " • private" : ""}`,
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
        <ConfigEditor apiUrl="/api/opencode-config" disabled={loadingRepos} />
      ) : selectedRepoObj ? (
        <ConfigEditor
          apiUrl={`/api/repos/${selectedRepoObj.owner}/${selectedRepoObj.name}/opencode-config`}
          disabled={loadingRepos}
        />
      ) : (
        <p className="text-sm text-muted-foreground mt-4">
          Select a repository to manage its config.
        </p>
      )}
    </div>
  );
}
