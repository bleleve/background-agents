"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArchiveSessionDialog } from "@/components/archive-session-dialog";
import type { Artifact } from "@/types/session";
import {
  GlobeIcon,
  GitPrIcon,
  ArchiveIcon,
  MoreIcon,
  LinkIcon,
  GitHubIcon,
  RefreshIcon,
} from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getSafeExternalUrl } from "@/lib/urls";

interface ActionBarProps {
  sessionId: string;
  sessionStatus: string;
  artifacts: Artifact[];
  /**
   * Set for PR-review sessions only (the reviewed PR number). Shows the
   * "Re-run review" action; left undefined for build/comment sessions.
   */
  reviewPrNumber?: number | null;
  /**
   * Whether the agent is currently executing (thinking/streaming). When true,
   * the "Re-run review" action is disabled to avoid racing an in-flight review.
   */
  isProcessing?: boolean;
  onArchive?: () => void | Promise<void>;
  onUnarchive?: () => void | Promise<void>;
}

export function ActionBar({
  sessionId,
  sessionStatus,
  artifacts,
  reviewPrNumber,
  isProcessing = false,
  onArchive,
  onUnarchive,
}: ActionBarProps) {
  const router = useRouter();
  const [isArchiving, setIsArchiving] = useState(false);
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [isRerunningReview, setIsRerunningReview] = useState(false);

  const prArtifact = artifacts.find((a) => a.type === "pr");
  const previewArtifact = artifacts.find((a) => a.type === "preview");
  const mediaCount = artifacts.filter(
    (artifact) => artifact.type === "screenshot" || artifact.type === "video"
  ).length;
  const previewUrl = getSafeExternalUrl(previewArtifact?.url);
  const prUrl = getSafeExternalUrl(prArtifact?.url);

  const isArchived = sessionStatus === "archived";

  const handleArchiveToggle = async () => {
    if (!isArchived) {
      setShowArchiveDialog(true);
      return;
    }

    setIsArchiving(true);
    try {
      if (onUnarchive) await onUnarchive();
    } finally {
      setIsArchiving(false);
    }
  };

  const handleConfirmArchive = async () => {
    setShowArchiveDialog(false);
    setIsArchiving(true);
    try {
      if (onArchive) await onArchive();
    } finally {
      setIsArchiving(false);
    }
  };

  const handleRerunReview = async () => {
    if (reviewPrNumber === undefined || reviewPrNumber === null) return;
    setIsRerunningReview(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/rerun-review`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as {
        sessionId?: string;
        error?: string;
      };
      if (!res.ok) {
        toast.error(data.error || "Failed to re-run review");
        return;
      }
      toast.success("Review re-triggered");
      if (data.sessionId && data.sessionId !== sessionId) {
        router.push(`/session/${data.sessionId}`);
      }
    } catch {
      toast.error("Failed to re-run review");
    } finally {
      setIsRerunningReview(false);
    }
  };

  const handleCopyLink = async () => {
    const url = `${window.location.origin}/session/${sessionId}`;
    await navigator.clipboard.writeText(url);
    toast.success("Link copied to clipboard");
  };

  return (
    <>
      <div className="flex flex-wrap items-stretch gap-2">
        {/* View Preview */}
        {previewUrl && (
          <Button variant="outline" size="sm" className="gap-1.5" asChild>
            <a href={previewUrl} target="_blank" rel="noopener noreferrer">
              <GlobeIcon className="w-4 h-4" />
              <span>View preview</span>
              {previewArtifact?.metadata?.previewStatus === "outdated" && (
                <span className="text-xs text-warning">(outdated)</span>
              )}
            </a>
          </Button>
        )}

        {/* View PR */}
        {prUrl && (
          <Button variant="outline" size="sm" className="gap-1.5" asChild>
            <a href={prUrl} target="_blank" rel="noopener noreferrer">
              <GitPrIcon className="w-4 h-4" />
              <span>View PR</span>
            </a>
          </Button>
        )}

        {/* Re-run automated review (review sessions only) */}
        {reviewPrNumber !== undefined && reviewPrNumber !== null && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleRerunReview}
            disabled={isRerunningReview || isProcessing}
            title={
              isProcessing
                ? "Wait for the current run to finish before re-running the review"
                : undefined
            }
            className="gap-1.5"
          >
            <RefreshIcon className="w-4 h-4" />
            <span>{isRerunningReview ? "Re-running…" : "Re-run review"}</span>
          </Button>
        )}

        {/* Archive/Unarchive */}
        <Button
          variant="outline"
          size="sm"
          onClick={handleArchiveToggle}
          disabled={isArchiving}
          className="gap-1.5"
        >
          <ArchiveIcon className="w-4 h-4" />
          <span>{isArchived ? "Unarchive" : "Archive"}</span>
        </Button>

        {mediaCount > 0 && (
          <div className="inline-flex items-center rounded-md border border-border-muted px-3 text-sm text-muted-foreground">
            Media ({mediaCount})
          </div>
        )}

        {/* More menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="!px-2">
              <MoreIcon className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top">
            <DropdownMenuItem onClick={handleCopyLink}>
              <LinkIcon className="w-4 h-4" />
              Copy link
            </DropdownMenuItem>
            {prUrl && (
              <DropdownMenuItem asChild>
                <a href={prUrl} target="_blank" rel="noopener noreferrer">
                  <GitHubIcon className="w-4 h-4" />
                  View in GitHub
                </a>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ArchiveSessionDialog
        open={showArchiveDialog}
        onOpenChange={setShowArchiveDialog}
        onConfirm={handleConfirmArchive}
      />
    </>
  );
}
