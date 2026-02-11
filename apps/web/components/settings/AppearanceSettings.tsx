"use client";

import { useEffect } from "react";
import { useAtom } from "jotai";
import { themeModeAtom, persistThemeMode, type ThemeMode } from "@/atoms";
import { SettingsCard, SettingsSection, SettingsSegmentedControl } from "./primitives";

const OPTIONS: Array<{ value: string; label: string }> = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" }
];

function resolveTheme(mode: ThemeMode): "dark" | "light" {
  if (mode === "system") {
    if (typeof window === "undefined") return "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode;
}

export function AppearanceSettings(): React.ReactElement {
  const [mode, setMode] = useAtom(themeModeAtom);

  useEffect(() => {
    const applied = resolveTheme(mode);
    document.documentElement.dataset.theme = applied;
  }, [mode]);

  return (
    <div className="flex flex-col gap-4">
      <SettingsSection title="外观" description="主题模式（本地存储）">
        <SettingsCard>
          <SettingsSegmentedControl
            label="主题"
            value={mode}
            onValueChange={(value) => {
              const next = value as ThemeMode;
              setMode(next);
              persistThemeMode(next);
            }}
            options={OPTIONS}
          />
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
