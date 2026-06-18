import type { SandboxStatus } from "@open-inspect/shared";
import { BOOTING_SANDBOX_STATUSES } from "./sandbox-statuses";

export interface PreviewDisplay {
  /** URLs to render in the Preview row, or null to hide it. */
  previewUrls: Record<string, string> | null;
  /**
   * Whether to show the "Starting…" label — the sandbox is booting over a known
   * preview, so the URL isn't live yet. Deliberately neutral: this covers both a
   * first boot and a relaunch (the two aren't reliably distinguishable, since a
   * preview URL can already be present from a snapshot while the box connects).
   */
  starting: boolean;
}

/**
 * Decide what the sidebar Preview row shows. While the sandbox boots it isn't
 * live and often drops its tunnel URLs until it (re)publishes; falling back to
 * the last-known set keeps the row visible (greyed, "Starting…") across that gap
 * instead of letting it vanish and reappear. Outside a boot, only the live URLs
 * are shown (null hides the row).
 */
export function resolvePreviewDisplay(args: {
  liveTunnelUrls: Record<string, string> | null;
  lastTunnelUrls: Record<string, string> | null;
  sandboxStatus: SandboxStatus;
}): PreviewDisplay {
  const { liveTunnelUrls, lastTunnelUrls, sandboxStatus } = args;
  const booting = BOOTING_SANDBOX_STATUSES.has(sandboxStatus);
  const previewUrls = liveTunnelUrls ?? (booting ? lastTunnelUrls : null);
  return { previewUrls, starting: booting && previewUrls !== null };
}
