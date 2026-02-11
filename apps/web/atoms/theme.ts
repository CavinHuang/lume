import { atom } from "jotai";

export type ThemeMode = "dark" | "light" | "system";

const STORAGE_KEY = "lume-theme-mode";

function loadThemeMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "dark" || raw === "light" || raw === "system") return raw;
  } catch {
    // ignore
  }
  return "dark";
}

export const themeModeAtom = atom<ThemeMode>(loadThemeMode());

export const resolvedThemeAtom = atom<"dark" | "light">((get) => {
  const mode = get(themeModeAtom);
  if (mode === "system") {
    if (typeof window === "undefined") return "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode;
});

export function persistThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}
