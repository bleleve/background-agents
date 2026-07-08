"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { mutate } from "swr";
import React, { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { useSidebarContext } from "@/components/sidebar-layout";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { formatModelNameLower } from "@/lib/format";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import { shouldWarmForPrompt } from "@/lib/sandbox-warming";
import { isUnarchivedSessionListKey } from "@/lib/session-list";
import { APP_NAME } from "@/lib/site-config";
import {
  DEFAULT_MODEL,
  getDefaultReasoningEffort,
  isValidReasoningEffort,
  type ModelCategory,
} from "@open-inspect/shared";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { useRepos, type Repo } from "@/hooks/use-repos";
import { useBranches } from "@/hooks/use-branches";
import { ReasoningEffortPills } from "@/components/reasoning-effort-pills";
import {
  SidebarIcon,
  RepoIcon,
  ModelIcon,
  BranchIcon,
  ChevronDownIcon,
  SendIcon,
  PaperclipIcon,
  XIcon,
} from "@/components/ui/icons";
import { Combobox, type ComboboxGroup } from "@/components/ui/combobox";

const LAST_SELECTED_REPO_STORAGE_KEY = "open-inspect-last-selected-repo";
const LAST_SELECTED_MODEL_STORAGE_KEY = "open-inspect-last-selected-model";
// Set to "true" when the stored model came from an explicit user pick (not
// an auto-switch from the Plan toggle or API default). Gates whether the
// stored model is restored on hydration.
const LAST_SELECTED_MODEL_USER_PICKED_STORAGE_KEY = "open-inspect-last-selected-model-user-picked";
const LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY = "open-inspect-last-selected-reasoning-effort";

export default function Home() {
  const { data: session } = useSession();
  const router = useRouter();
  const { repos, loading: loadingRepos } = useRepos();
  const [selectedRepo, setSelectedRepo] = useState<string>("");
  const [planMode, setPlanMode] = useState<boolean>(false);
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  const [reasoningEffort, setReasoningEffort] = useState<string | undefined>(
    getDefaultReasoningEffort(DEFAULT_MODEL)
  );
  const [selectedBranch, setSelectedBranch] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [queuedFiles, setQueuedFiles] = useState<File[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const sessionCreationPromise = useRef<Promise<string | null> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const pendingConfigRef = useRef<{ repo: string; model: string; branch: string } | null>(null);
  const [hasHydratedModelPreferences, setHasHydratedModelPreferences] = useState(false);
  // Tracks whether the user explicitly picked a model *in this visit* (via the
  // dropdown). When false, toggling Plan auto-swaps between the deployment's
  // defaultModel and defaultPlanModel. A pick remembered from a previous visit
  // is restored as the initial model but does NOT set this ref — otherwise a
  // one-time pick would permanently disable the Plan auto-switch on every later
  // visit (it persisted in localStorage and was replayed into this ref).
  const userPickedModelRef = useRef(false);
  // Tracks whether the user explicitly clicked the Plan toggle *in this
  // visit*. When false, planMode is sent as `undefined` on session create so
  // the control plane can infer plan-vs-direct via the intent classifier
  // instead of defaulting to the toggle's initial `false` state.
  const planModeTouchedRef = useRef(false);
  // Previous Plan-toggle value, so the auto-switch reacts only to real toggles
  // (not initial hydration or unrelated re-renders) and never clobbers a
  // remembered/picked model on load.
  const prevPlanModeRef = useRef(planMode);
  // Build-mode model captured when entering Plan mode, restored when leaving it.
  const buildModelRef = useRef<string | null>(null);
  const { enabledModels, enabledModelOptions, defaultModel, defaultPlanModel } = useEnabledModels();
  const selectedRepoOwner = selectedRepo.split("/")[0] ?? "";
  const selectedRepoName = selectedRepo.split("/")[1] ?? "";
  const { branches, loading: loadingBranches } = useBranches(selectedRepoOwner, selectedRepoName);

  // Auto-select repo when repos load
  useEffect(() => {
    if (repos.length > 0 && !selectedRepo) {
      const lastSelectedRepo = localStorage.getItem(LAST_SELECTED_REPO_STORAGE_KEY);
      const hasLastSelectedRepo = repos.some((repo) => repo.fullName === lastSelectedRepo);
      const defaultRepo =
        (hasLastSelectedRepo ? lastSelectedRepo : repos[0].fullName) ?? repos[0].fullName;
      setSelectedRepo(defaultRepo);
      const repo = repos.find((r) => r.fullName === defaultRepo);
      if (repo) setSelectedBranch(repo.defaultBranch);
    }
  }, [repos, selectedRepo]);

  useEffect(() => {
    if (!selectedRepo) return;
    localStorage.setItem(LAST_SELECTED_REPO_STORAGE_KEY, selectedRepo);
  }, [selectedRepo]);

  useEffect(() => {
    if (enabledModels.length === 0 || hasHydratedModelPreferences) return;

    const storedModel = localStorage.getItem(LAST_SELECTED_MODEL_STORAGE_KEY);
    const storedUserPicked =
      localStorage.getItem(LAST_SELECTED_MODEL_USER_PICKED_STORAGE_KEY) === "true";
    // Only restore the stored model when it was an explicit user pick. Auto-
    // switched values from a prior session (Plan toggle, API default) must not
    // sticky-override the API defaults, otherwise toggling Plan once would
    // lock the user onto that model on every subsequent reload.
    const storedModelIsValid =
      storedUserPicked && !!storedModel && enabledModels.includes(storedModel);
    const initialDefault = planMode ? defaultPlanModel : defaultModel;
    const selectedModelFromStorage = storedModelIsValid
      ? storedModel!
      : enabledModels.includes(initialDefault)
        ? initialDefault
        : (enabledModels[0] ?? DEFAULT_MODEL);

    // NB: a remembered pick is restored as the initial model above, but we do
    // NOT replay it into userPickedModelRef — that ref is scoped to picks made
    // in this visit so a prior pick can't permanently block the Plan auto-switch.

    const storedReasoningEffort = localStorage.getItem(LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY);
    const reasoningEffortFromStorage =
      storedReasoningEffort &&
      isValidReasoningEffort(selectedModelFromStorage, storedReasoningEffort)
        ? storedReasoningEffort
        : getDefaultReasoningEffort(selectedModelFromStorage);

    setSelectedModel(selectedModelFromStorage);
    setReasoningEffort(reasoningEffortFromStorage);
    setHasHydratedModelPreferences(true);
  }, [enabledModels, hasHydratedModelPreferences, defaultModel, defaultPlanModel, planMode]);

  useEffect(() => {
    if (!hasHydratedModelPreferences) return;

    // Persist only a deliberate pick from this visit. Auto-switched values (Plan
    // toggle / API default) leave userPickedModelRef false and are never
    // written, so they don't sticky-override the defaults later. We never clear
    // the remembered model here: a prior pick must survive reloads where the
    // user hasn't re-picked (clearing would erase the just-restored model on the
    // first render after hydration).
    if (userPickedModelRef.current) {
      localStorage.setItem(LAST_SELECTED_MODEL_STORAGE_KEY, selectedModel);
      localStorage.setItem(LAST_SELECTED_MODEL_USER_PICKED_STORAGE_KEY, "true");
    }

    if (reasoningEffort) {
      localStorage.setItem(LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY, reasoningEffort);
    } else {
      localStorage.removeItem(LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY);
    }
  }, [hasHydratedModelPreferences, selectedModel, reasoningEffort]);

  useEffect(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setPendingSessionId(null);
    setIsCreatingSession(false);
    sessionCreationPromise.current = null;
    pendingConfigRef.current = null;
  }, [selectedRepo, selectedModel, selectedBranch]);

  const createSessionForWarming = useCallback(
    async (source: "warmup" | "submit") => {
      if (pendingSessionId) return pendingSessionId;
      if (sessionCreationPromise.current) return sessionCreationPromise.current;
      if (!selectedRepo) return null;

      setIsCreatingSession(true);
      const [owner, name] = selectedRepo.split("/");
      const currentConfig = { repo: selectedRepo, model: selectedModel, branch: selectedBranch };
      pendingConfigRef.current = currentConfig;

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      const promise = (async () => {
        try {
          const res = await fetch("/api/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              repoOwner: owner,
              repoName: name,
              model: selectedModel,
              reasoningEffort,
              branch: selectedBranch || undefined,
              // Untouched this visit -> undefined, so the control plane infers
              // plan-vs-direct via the intent classifier instead of defaulting
              // to the toggle's initial `false`. A real click always wins.
              planMode: planModeTouchedRef.current ? planMode : undefined,
              // In plan mode the picker controls the planning model, so send it as
              // planModel too. Otherwise the control plane defaults plan_model to
              // DEFAULT_PLAN_MODEL and the "Plan" line shows the wrong model.
              planModel: planMode ? selectedModel : undefined,
              // Classifier input when planMode is inferred (ignored otherwise) —
              // the session's first prompt isn't sent until after creation (see
              // the separate POST .../prompt call below), so the in-progress
              // composer text is the only signal available at create time.
              // Restricted to source === "submit": this function is idempotent
              // (guarded above) and usually fires from handlePromptChange's
              // pre-warm the moment shouldWarmForPrompt trips, well before the
              // user finishes typing — classifying that partial prefix would
              // permanently misjudge intent since a later, complete submit
              // reuses the pre-warmed session instead of re-creating it. Warmup
              // creation skips classification and lets the server fall back to
              // direct; only a submit that outraces pre-warming classifies,
              // where `prompt` is genuinely the full text.
              planClassificationText:
                !planModeTouchedRef.current && source === "submit" ? prompt : undefined,
            }),
            signal: abortController.signal,
          });

          if (res.ok) {
            const data = await res.json();
            if (
              pendingConfigRef.current?.repo === currentConfig.repo &&
              pendingConfigRef.current?.model === currentConfig.model &&
              pendingConfigRef.current?.branch === currentConfig.branch
            ) {
              setPendingSessionId(data.sessionId);
              return data.sessionId as string;
            }
            return null;
          }
          return null;
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            return null;
          }
          console.error("Failed to create session for warming:", error);
          return null;
        } finally {
          if (abortControllerRef.current === abortController) {
            setIsCreatingSession(false);
            sessionCreationPromise.current = null;
            abortControllerRef.current = null;
          }
        }
      })();

      sessionCreationPromise.current = promise;
      return promise;
    },
    [
      selectedRepo,
      selectedModel,
      reasoningEffort,
      selectedBranch,
      planMode,
      pendingSessionId,
      prompt,
    ]
  );

  // Toggling plan-mode invalidates any pre-warmed session so the next
  // submission creates a session with the matching planMode flag.
  useEffect(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setPendingSessionId(null);
    setIsCreatingSession(false);
    sessionCreationPromise.current = null;
    pendingConfigRef.current = null;
  }, [planMode]);

  // Reset selections when model preferences change (only after hydration)
  useEffect(() => {
    if (!hasHydratedModelPreferences) return;

    if (enabledModels.length > 0 && !enabledModels.includes(selectedModel)) {
      const preferred = planMode ? defaultPlanModel : defaultModel;
      const fallback = enabledModels.includes(preferred)
        ? preferred
        : (enabledModels[0] ?? DEFAULT_MODEL);
      setSelectedModel(fallback);
      setReasoningEffort(getDefaultReasoningEffort(fallback));
      return;
    }

    if (reasoningEffort && !isValidReasoningEffort(selectedModel, reasoningEffort)) {
      setReasoningEffort(getDefaultReasoningEffort(selectedModel));
    }
  }, [
    hasHydratedModelPreferences,
    enabledModels,
    selectedModel,
    reasoningEffort,
    defaultModel,
    defaultPlanModel,
    planMode,
  ]);

  // Auto-switch the model when the Plan toggle actually flips, unless the user
  // deliberately picked a model in this visit. Entering Plan mode switches to
  // the deployment's defaultPlanModel; leaving it restores the build model we
  // came in with. The prevPlanModeRef guard means this only reacts to a real
  // toggle (never initial hydration or unrelated re-renders), so a remembered
  // model isn't clobbered on load and a pick from a *previous* visit no longer
  // blocks the switch.
  useEffect(() => {
    if (!hasHydratedModelPreferences) return;
    if (prevPlanModeRef.current === planMode) return;
    prevPlanModeRef.current = planMode;
    if (userPickedModelRef.current) return;

    if (planMode) buildModelRef.current = selectedModel;
    const target = planMode ? defaultPlanModel : (buildModelRef.current ?? defaultModel);
    if (!target) return;
    if (enabledModels.length > 0 && !enabledModels.includes(target)) return;
    if (target === selectedModel) return;

    setSelectedModel(target);
    setReasoningEffort(getDefaultReasoningEffort(target));
  }, [
    planMode,
    hasHydratedModelPreferences,
    defaultModel,
    defaultPlanModel,
    enabledModels,
    selectedModel,
  ]);

  const handleRepoChange = useCallback(
    (repoFullName: string) => {
      setSelectedRepo(repoFullName);
      const repo = repos.find((r) => r.fullName === repoFullName);
      if (repo) setSelectedBranch(repo.defaultBranch);
    },
    [repos]
  );

  const handleModelChange = useCallback((model: string) => {
    userPickedModelRef.current = true;
    setSelectedModel(model);
    setReasoningEffort(getDefaultReasoningEffort(model));
  }, []);

  const handlePlanModeChange = useCallback((value: boolean) => {
    planModeTouchedRef.current = true;
    setPlanMode(value);
  }, []);

  const handlePromptChange = (value: string) => {
    setPrompt(value);
    // Warm a sandbox once the input shows real intent (see shouldWarmForPrompt)
    // so it's ready by submit — but not for a stray space or a couple of
    // keystrokes. createSessionForWarming() is idempotent (guards on
    // pendingSessionId / the in-flight promise), so later keystrokes are no-ops.
    if (shouldWarmForPrompt(value) && !pendingSessionId && !isCreatingSession && selectedRepo) {
      createSessionForWarming("warmup");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() && queuedFiles.length === 0) return;
    if (!selectedRepo) {
      setError("Please select a repository");
      return;
    }

    setCreating(true);
    setError("");

    try {
      let sessionId = pendingSessionId;
      if (!sessionId) {
        sessionId = await createSessionForWarming("submit");
      }

      if (!sessionId) {
        setError("Failed to create session");
        setCreating(false);
        return;
      }

      const uploadedFiles: { artifactId: string; fileName: string }[] = [];

      if (queuedFiles.length > 0) {
        setUploadingFiles(true);

        for (const file of queuedFiles) {
          try {
            const formData = new FormData();
            formData.append("file", file, file.name);
            const response = await fetch(`/api/sessions/${sessionId}/files`, {
              method: "POST",
              body: formData,
            });
            if (response.ok) {
              const data = (await response.json()) as { artifactId: string; fileName: string };
              uploadedFiles.push({ artifactId: data.artifactId, fileName: data.fileName });
            } else {
              console.error(`Failed to upload file: ${file.name}`);
            }
          } catch (uploadError) {
            console.error(`Error uploading file: ${file.name}`, uploadError);
          }
        }

        setUploadingFiles(false);
        setQueuedFiles([]);
      }

      let content = prompt;
      if (uploadedFiles.length > 0) {
        const fileList = uploadedFiles
          .map((f) => `- ${f.fileName} (artifact_id: ${f.artifactId})`)
          .join("\n");
        content = `${prompt}\n\nUploaded files (use the download_file tool with the artifact_id to access them):\n${fileList}`;
      }

      const res = await fetch(`/api/sessions/${sessionId}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          model: selectedModel,
          reasoningEffort,
        }),
      });

      if (res.ok) {
        mutate(isUnarchivedSessionListKey);
        router.push(`/session/${sessionId}`);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to send prompt");
        setCreating(false);
      }
    } catch (_error) {
      setError("Failed to create session");
      setCreating(false);
    }
  };

  return (
    <HomeContent
      isAuthenticated={!!session}
      repos={repos}
      loadingRepos={loadingRepos}
      selectedRepo={selectedRepo}
      setSelectedRepo={handleRepoChange}
      selectedBranch={selectedBranch}
      setSelectedBranch={setSelectedBranch}
      branches={branches}
      loadingBranches={loadingBranches}
      selectedModel={selectedModel}
      setSelectedModel={handleModelChange}
      reasoningEffort={reasoningEffort}
      setReasoningEffort={setReasoningEffort}
      planMode={planMode}
      setPlanMode={handlePlanModeChange}
      prompt={prompt}
      handlePromptChange={handlePromptChange}
      creating={creating}
      isCreatingSession={isCreatingSession}
      uploadingFiles={uploadingFiles}
      queuedFiles={queuedFiles}
      setQueuedFiles={setQueuedFiles}
      fileInputRef={fileInputRef}
      error={error}
      handleSubmit={handleSubmit}
      modelOptions={enabledModelOptions}
    />
  );
}

function HomeContent({
  isAuthenticated,
  repos,
  loadingRepos,
  selectedRepo,
  setSelectedRepo,
  selectedBranch,
  setSelectedBranch,
  branches,
  loadingBranches,
  selectedModel,
  setSelectedModel,
  reasoningEffort,
  setReasoningEffort,
  planMode,
  setPlanMode,
  prompt,
  handlePromptChange,
  creating,
  isCreatingSession,
  uploadingFiles,
  queuedFiles,
  setQueuedFiles,
  fileInputRef,
  error,
  handleSubmit,
  modelOptions,
}: {
  isAuthenticated: boolean;
  repos: Repo[];
  loadingRepos: boolean;
  selectedRepo: string;
  setSelectedRepo: (value: string) => void;
  selectedBranch: string;
  setSelectedBranch: (value: string) => void;
  branches: { name: string }[];
  loadingBranches: boolean;
  selectedModel: string;
  setSelectedModel: (value: string) => void;
  reasoningEffort: string | undefined;
  setReasoningEffort: (value: string | undefined) => void;
  planMode: boolean;
  setPlanMode: (value: boolean) => void;
  prompt: string;
  handlePromptChange: (value: string) => void;
  creating: boolean;
  isCreatingSession: boolean;
  uploadingFiles: boolean;
  queuedFiles: File[];
  setQueuedFiles: React.Dispatch<React.SetStateAction<File[]>>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  error: string;
  handleSubmit: (e: React.FormEvent) => void;
  modelOptions: ModelCategory[];
}) {
  const { isOpen, toggle } = useSidebarContext();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;

    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const selectedRepoObj = repos.find((r) => r.fullName === selectedRepo);
  const displayRepoName = selectedRepoObj ? selectedRepoObj.name : "Select repo";

  return (
    <div className="h-full flex flex-col">
      {/* Header with toggle when sidebar is closed */}
      {!isOpen && (
        <header className="border-b border-border-muted flex-shrink-0">
          <div className="px-4 py-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggle}
              title={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
              aria-label={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
            >
              <SidebarIcon className="w-4 h-4" />
            </Button>
          </div>
        </header>
      )}

      <div className="flex-1 flex flex-col items-center justify-center p-8">
        <div className="w-full max-w-2xl">
          {/* Welcome text */}
          <div className="text-center mb-8">
            <h1 className="text-3xl font-semibold text-foreground mb-2">Welcome to {APP_NAME}</h1>
            {isAuthenticated ? (
              <p className="text-muted-foreground">
                Ask a question or describe what you want to build
              </p>
            ) : (
              <p className="text-muted-foreground">Sign in to start a new session</p>
            )}
          </div>

          {/* Input box - only show when authenticated */}
          {isAuthenticated && (
            <form onSubmit={handleSubmit}>
              {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}

              <div className="border border-border bg-input">
                {/* Queued files list */}
                {queuedFiles.length > 0 && (
                  <div className="px-4 pt-3 flex flex-wrap gap-2">
                    {queuedFiles.map((file, idx) => (
                      <div
                        key={`${file.name}-${idx}`}
                        className="flex items-center gap-1.5 bg-muted px-2 py-1 text-xs text-foreground max-w-[200px]"
                      >
                        <span className="truncate">{file.name}</span>
                        <button
                          type="button"
                          onClick={() => setQueuedFiles((prev) => prev.filter((_, i) => i !== idx))}
                          className="text-secondary-foreground hover:text-destructive flex-shrink-0 transition"
                          aria-label={`Remove ${file.name}`}
                        >
                          <XIcon className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Text input area */}
                <div className="relative">
                  <textarea
                    ref={inputRef}
                    value={prompt}
                    onChange={(e) => handlePromptChange(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="What do you want to build?"
                    disabled={creating}
                    className="w-full resize-none bg-transparent px-4 pt-4 pb-12 focus:outline-none text-foreground placeholder:text-secondary-foreground disabled:opacity-50"
                    rows={3}
                  />
                  {/* Hidden file input */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? []);
                      if (files.length > 0) {
                        setQueuedFiles((prev) => [...prev, ...files]);
                      }
                      e.target.value = "";
                    }}
                  />
                  {/* Floating action buttons */}
                  <div className="absolute bottom-3 right-3 flex items-center gap-2">
                    {uploadingFiles && (
                      <span className="text-xs text-muted-foreground">Uploading...</span>
                    )}
                    {isCreatingSession && !uploadingFiles && (
                      <span className="text-xs text-accent">Warming sandbox...</span>
                    )}
                    {/* Attach file button */}
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={creating}
                      className="p-2 text-secondary-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition"
                      title="Attach file"
                      aria-label="Attach file"
                    >
                      <PaperclipIcon className="w-5 h-5" />
                    </button>
                    <button
                      type="submit"
                      disabled={
                        (!prompt.trim() && queuedFiles.length === 0) || creating || !selectedRepo
                      }
                      className="p-2 text-secondary-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition"
                      title={`Send (${SHORTCUT_LABELS.SEND_PROMPT})`}
                      aria-label={`Send (${SHORTCUT_LABELS.SEND_PROMPT})`}
                    >
                      {creating ? (
                        <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <SendIcon className="w-5 h-5" />
                      )}
                    </button>
                  </div>
                </div>

                {/* Footer row with repo and model selectors */}
                <div className="flex flex-col gap-2 px-4 py-2 border-t border-border-muted sm:flex-row sm:items-center sm:justify-between sm:gap-0">
                  {/* Left side - Repo selector + Model selector */}
                  <div className="flex flex-wrap items-center gap-2 sm:gap-4 min-w-0">
                    {/* Repo selector */}
                    <Combobox
                      value={selectedRepo}
                      onChange={(value) => setSelectedRepo(value)}
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
                      direction="up"
                      dropdownWidth="w-72"
                      disabled={creating || loadingRepos}
                      triggerClassName="flex max-w-full items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
                    >
                      <RepoIcon className="w-4 h-4" />
                      <span className="truncate max-w-[12rem] sm:max-w-none">
                        {loadingRepos ? "Loading..." : displayRepoName}
                      </span>
                      <ChevronDownIcon className="w-3 h-3" />
                    </Combobox>

                    {/* Branch selector */}
                    <Combobox
                      value={selectedBranch}
                      onChange={(value) => setSelectedBranch(value)}
                      items={branches.map((b) => ({
                        value: b.name,
                        label: b.name,
                      }))}
                      searchable
                      searchPlaceholder="Search branches..."
                      filterFn={(option, query) => option.label.toLowerCase().includes(query)}
                      direction="up"
                      dropdownWidth="w-56"
                      disabled={creating || !selectedRepo || loadingBranches}
                      triggerClassName="flex max-w-full items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
                    >
                      <BranchIcon className="w-3.5 h-3.5" />
                      <span className="truncate max-w-[9rem] sm:max-w-none">
                        {loadingBranches ? "Loading..." : selectedBranch || "branch"}
                      </span>
                      <ChevronDownIcon className="w-3 h-3" />
                    </Combobox>

                    {/* Model selector */}
                    <Combobox
                      value={selectedModel}
                      onChange={(value) => setSelectedModel(value)}
                      items={
                        modelOptions.map((group) => ({
                          category: group.category,
                          options: group.models.map((model) => ({
                            value: model.id,
                            label: model.name,
                            description: model.description,
                          })),
                        })) as ComboboxGroup[]
                      }
                      direction="up"
                      dropdownWidth="w-56"
                      disabled={creating}
                      triggerClassName="flex max-w-full items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
                    >
                      <ModelIcon className="w-3.5 h-3.5" />
                      <span className="truncate max-w-[9rem] sm:max-w-none">
                        {formatModelNameLower(selectedModel)}
                      </span>
                    </Combobox>

                    {/* Reasoning effort pills */}
                    <ReasoningEffortPills
                      selectedModel={selectedModel}
                      reasoningEffort={reasoningEffort}
                      onSelect={setReasoningEffort}
                      disabled={creating}
                    />

                    {/* Plan-first toggle: when on, the agent proposes a plan
                        that must be approved before any code is written. */}
                    <button
                      type="button"
                      onClick={() => setPlanMode(!planMode)}
                      disabled={creating}
                      aria-pressed={planMode}
                      className={`rounded border px-2 py-0.5 text-xs transition disabled:opacity-50 disabled:cursor-not-allowed ${
                        planMode
                          ? "border-accent bg-accent-muted text-accent"
                          : "border-border text-muted-foreground hover:text-foreground"
                      }`}
                      title={
                        planMode
                          ? "Plan mode is ON — the agent will wait for your approval before coding"
                          : "Turn on plan mode — the agent will propose a plan and wait for your approval"
                      }
                    >
                      Plan
                    </button>
                  </div>

                  {/* Right side - Agent label, mirrors the Plan toggle */}
                  <span className="hidden sm:inline text-sm text-muted-foreground">
                    {planMode ? "plan agent" : "build agent"}
                  </span>
                </div>
              </div>

              {selectedRepoObj && (
                <div className="mt-3 text-center">
                  <Link
                    href="/settings"
                    className="text-xs text-muted-foreground hover:text-foreground transition"
                  >
                    Manage secrets and settings
                  </Link>
                </div>
              )}

              {repos.length === 0 && !loadingRepos && (
                <p className="mt-3 text-sm text-muted-foreground text-center">
                  No repositories found. Make sure you have granted access to your repositories.
                </p>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
