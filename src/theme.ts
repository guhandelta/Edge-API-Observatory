/** The saved preference has two explicit states; system color is only the default. */
export type Theme = "light" | "dark";

const STORAGE_KEY = "edge-api-observatory-theme";

/** Read the saved choice, falling back to the operating system preference. */
export function getInitialTheme(): Theme {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Apply the palette before React paints; save only an explicit user choice. */
export function applyTheme(theme: Theme, persist = false): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    "content",
    theme === "dark" ? "#191c2e" : "#f0eff1",
  );
  if (persist) {
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // A session without storage can still switch themes until the page closes.
    }
  }
}
