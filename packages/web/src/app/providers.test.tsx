// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { Providers } from "./providers";

const sessionProviderProps = vi.fn();

vi.mock("next-auth/react", () => ({
  SessionProvider: (props: { children?: React.ReactNode } & Record<string, unknown>) => {
    sessionProviderProps(props);
    return <>{props.children}</>;
  },
}));

// Keep the test focused on the SessionProvider config; stub the leaf side-effect
// components so we don't pull in theme/stylesheet/toast behavior.
vi.mock("@/components/syntax-highlight-theme", () => ({
  SyntaxHighlightTheme: () => null,
}));
vi.mock("@/components/ui/sonner", () => ({
  Toaster: () => null,
}));
// next-themes reads window.matchMedia, which jsdom doesn't implement.
vi.mock("next-themes", () => ({
  ThemeProvider: (props: { children?: React.ReactNode }) => <>{props.children}</>,
}));

describe("Providers", () => {
  it("disables NextAuth session refetch on window focus", () => {
    render(
      <Providers>
        <div>child</div>
      </Providers>
    );

    expect(sessionProviderProps).toHaveBeenCalled();
    // Spurious sign-in bounces on tab/window refocus come from NextAuth's
    // default focus refetch; this must stay false.
    expect(sessionProviderProps.mock.calls[0][0].refetchOnWindowFocus).toBe(false);
  });
});
