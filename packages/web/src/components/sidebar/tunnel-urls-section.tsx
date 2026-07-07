"use client";

import { getSafeExternalUrl } from "@/lib/urls";
import { GlobeIcon } from "@/components/ui/icons";
import type { SandboxStatus } from "@open-inspect/shared";

interface TunnelUrlsSectionProps {
  urls: Record<string, string>;
  sandboxStatus: SandboxStatus;
  /** Optional per-port display labels, keyed by port number as a string. */
  labels?: Record<string, string> | null;
}

export function TunnelUrlsSection({ urls, labels }: TunnelUrlsSectionProps) {
  const entries = Object.entries(urls);
  // Each link is named by its configured label, or "Tunnel" as the default.
  // When more than one port is exposed, keep the port as a muted suffix to
  // disambiguate — useful even for labeled links (e.g. "API · 8990").
  const showPort = entries.length > 1;

  return (
    <div className="space-y-1.5">
      {entries.map(([port, url]) => {
        const safeUrl = getSafeExternalUrl(url);
        const label = (
          <>
            {labels?.[port] || "Tunnel"}
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
