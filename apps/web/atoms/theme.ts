import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

export type ThemeMode = "dark" | "light" | "system";

export const themeModeAtom = atomWithStorage<ThemeMode>("lume-theme-mode", "dark");

export const resolvedThemeAtom = atom<"dark" | "light">((get) => {
  const mode = get(themeModeAtom);
  if (mode === "system") {
    if (typeof window === "undefined") return "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode;
});
