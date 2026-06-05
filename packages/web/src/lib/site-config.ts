import { DEFAULT_APP_NAME } from "@open-inspect/shared";

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME?.trim() || DEFAULT_APP_NAME;

export const DEFAULT_APP_SHORT_NAME = "Inspect";
export const DEFAULT_FAVICON_URL = "/favicon.ico";

/**
 * Short brand label shown in the sidebar header next to the logo.
 * Defaults to "Reef". Set NEXT_PUBLIC_APP_SHORT_NAME to override (defaults
 * to APP_NAME when neither is set explicitly, but stays "Reef" for the
 * built-in brand).
 */
export const APP_SHORT_NAME =
  process.env.NEXT_PUBLIC_APP_SHORT_NAME?.trim() ||
  (process.env.NEXT_PUBLIC_APP_NAME?.trim()
    ? APP_NAME === DEFAULT_APP_NAME
      ? DEFAULT_APP_SHORT_NAME
      : APP_NAME
    : "Reef");

export const APP_ICON_URL = process.env.NEXT_PUBLIC_APP_ICON_URL?.trim() || "";
export const APP_FAVICON_URL = APP_ICON_URL || DEFAULT_FAVICON_URL;
