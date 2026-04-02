import { readStoredValue, writeStoredValue } from "@/lib/persist";

export type ThemeMode = "light" | "dark";

const STORAGE_KEY = "workhorse.theme";

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark";
}

export function getPreferredTheme(): ThemeMode {
  const stored = readStoredValue<ThemeMode | null>(STORAGE_KEY, null);
  return isThemeMode(stored) ? stored : "light";
}

export function applyTheme(theme: ThemeMode, persist = true): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.documentElement.classList.toggle("dark", theme === "dark");
  }

  if (persist) {
    writeStoredValue(STORAGE_KEY, theme);
  }
}

export function initializeTheme(): ThemeMode {
  const theme = getPreferredTheme();
  applyTheme(theme, false);
  return theme;
}
