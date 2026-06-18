import { describe, expect, it } from "vitest";
import { resolvePreviewDisplay } from "./preview-display";

const URLS = { "3000": "https://app.example.dev" };
const OLD = { "3000": "https://old.example.dev" };

describe("resolvePreviewDisplay", () => {
  it("shows the live URLs and no Restarting label when the sandbox is live", () => {
    expect(
      resolvePreviewDisplay({ liveTunnelUrls: URLS, lastTunnelUrls: OLD, sandboxStatus: "ready" })
    ).toEqual({ previewUrls: URLS, restarting: false });
  });

  it("keeps the last-known preview greyed with a Restarting label while booting", () => {
    expect(
      resolvePreviewDisplay({
        liveTunnelUrls: null,
        lastTunnelUrls: OLD,
        sandboxStatus: "spawning",
      })
    ).toEqual({ previewUrls: OLD, restarting: true });
  });

  it("prefers live URLs over the last-known set even while booting", () => {
    expect(
      resolvePreviewDisplay({
        liveTunnelUrls: URLS,
        lastTunnelUrls: OLD,
        sandboxStatus: "connecting",
      })
    ).toEqual({ previewUrls: URLS, restarting: true });
  });

  it("hides the row when stopped with no live preview (Restart link stands alone)", () => {
    expect(
      resolvePreviewDisplay({ liveTunnelUrls: null, lastTunnelUrls: OLD, sandboxStatus: "stopped" })
    ).toEqual({ previewUrls: null, restarting: false });
  });

  it("does not invent a preview on first boot when none was ever published", () => {
    expect(
      resolvePreviewDisplay({
        liveTunnelUrls: null,
        lastTunnelUrls: null,
        sandboxStatus: "spawning",
      })
    ).toEqual({ previewUrls: null, restarting: false });
  });
});
