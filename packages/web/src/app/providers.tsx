"use client";

import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { SWRConfig } from "swr";
import { Toaster } from "@/components/ui/sonner";
import { SyntaxHighlightTheme } from "@/components/syntax-highlight-theme";

async function swrFetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res.json();
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <SWRConfig value={{ fetcher: swrFetcher, revalidateOnFocus: true, dedupingInterval: 2000 }}>
        {/*
         * refetchOnWindowFocus is disabled: NextAuth otherwise re-fetches
         * /api/auth/session on every tab/window focus, and a transient failure
         * of that refetch nulls the client session and bounces the user to the
         * sign-in screen (sidebar-layout renders it whenever useSession() is
         * null) even though the 90-day JWT cookie is still valid. The session is
         * still validated server-side on every protected request and on full
         * page loads, so disabling the focus refetch removes the spurious
         * logouts without weakening auth.
         */}
        <SessionProvider refetchOnWindowFocus={false}>
          {children}
          <SyntaxHighlightTheme />
          <Toaster />
        </SessionProvider>
      </SWRConfig>
    </ThemeProvider>
  );
}
