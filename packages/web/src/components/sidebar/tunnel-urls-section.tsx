"use client";

import { getSafeExternalUrl } from "@/lib/urls";
import { GlobeIcon } from "@/components/ui/icons";
import type { SandboxStatus } from "@open-inspect/shared";

interface TunnelUrlsSectionProps {
  urls: Record<string, string>;
  sandboxStatus: SandboxStatus;
}

export function TunnelUrlsSection({ urls }: TunnelUrlsSectionProps) {
  const entries = Object.entries(urls);
  // "Preview" is the user-facing name for the running app's tunnel. When more
  // than one port is exposed, keep the port as a muted suffix to disambiguate.
  const showPort = entries.length > 1;

  return (
    <div className="space-y-1.5">
      {entries.map(([port, url]) => {
        const safeUrl = getSafeExternalUrl(url);
        const label = (
          <>
            Preview
            {showPort && <span className="text-muted-foreground/70"> · {port}</span>}
          </>
        );
        return (
          <div key={port} className="flex items-center gap-2 text-sm">
            <GlobeIcon
              className={`w-4 h-4 shrink-0 ${safeUrl ? "text-muted-foreground" : "text-muted-foreground/50"}`}
            />
            {safeUrl ? (
              <a
                href={safeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline truncate"
              >
                {label}
              </a>
            ) : (
              <span className="text-muted-foreground truncate">{label}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
