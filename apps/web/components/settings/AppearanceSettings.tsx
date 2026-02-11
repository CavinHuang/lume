"use client";

import { useEffect } from "react";
import { useAtom } from "jotai";
import { themeModeAtom, persistThemeMode, type ThemeMode } from "@/atoms";
import { SettingsCard, SettingsRow, SettingsSection, SettingsSegmentedControl } from "./primitives";

const OPTIONS: Array<{ value: string; label: string }> = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" }
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
  const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
  const zoomHint = isMac
    ? "使用 ⌘+ 放大、⌘- 缩小、⌘0 恢复默认大小"
    : "使用 Ctrl++ 放大、Ctrl+- 缩小、Ctrl+0 恢复默认大小";

  useEffect(() => {
    const applied = resolveTheme(mode);
    document.documentElement.dataset.theme = applied;
  }, [mode]);

  return (
    <SettingsSection title="外观设置" description="自定义应用的视觉风格">
      <SettingsCard>
        <SettingsSegmentedControl
          label="主题模式"
          description="选择应用的配色方案"
          value={mode}
          onValueChange={(value) => {
            const next = value as ThemeMode;
            setMode(next);
            persistThemeMode(next);
          }}
          options={OPTIONS}
        />
        <SettingsRow label="界面缩放" description={zoomHint} />
      </SettingsCard>
    </SettingsSection>
  );
}
