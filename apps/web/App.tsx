"use client";

import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { IPC_PROTOCOL_VERSION } from "@lume/shared";
import { themeModeAtom, type ThemeMode, workspaceCapabilitiesVersionAtom, workspaceFilesVersionAtom } from "./atoms";
import { AppShell } from "./components/app-shell/AppShell";
import { TooltipProvider } from "./components/ui/tooltip";
import type { AppShellContextType } from "./contexts/AppShellContext";
import { onAgentCapabilitiesChanged, onAgentWorkspaceFilesChanged, sidecarCall } from "./lib/desktop-api";

function resolveTheme(mode: ThemeMode): "dark" | "light" {
  if (mode !== "system") {
    return mode;
  }
  if (typeof window === "undefined") {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyThemeToDocument(theme: "dark" | "light"): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("dark", theme === "dark");
}

export default function App(): React.ReactElement {
  const mode = useAtomValue(themeModeAtom);
  const bumpCapabilitiesVersion = useSetAtom(workspaceCapabilitiesVersionAtom);
  const bumpFilesVersion = useSetAtom(workspaceFilesVersionAtom);
  const contextValue: AppShellContextType = {};

  useEffect(() => {
    void sidecarCall<{ version?: number }>("healthcheck").then((result) => {
      if (result.version !== IPC_PROTOCOL_VERSION) {
        console.warn(`[App] IPC 协议版本不匹配: 前端=${IPC_PROTOCOL_VERSION}, sidecar=${result.version ?? "未知"}`);
      }
    }).catch(() => {/* sidecar 未就绪，忽略 */});
  }, []);

  useEffect(() => {
    applyThemeToDocument(resolveTheme(mode));

    if (mode !== "system") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemThemeChange = (): void => {
      applyThemeToDocument(mediaQuery.matches ? "dark" : "light");
    };

    mediaQuery.addEventListener("change", onSystemThemeChange);
    return () => {
      mediaQuery.removeEventListener("change", onSystemThemeChange);
    };
  }, [mode]);

  useEffect(() => {
    let dispose: UnlistenHandle | null = null;
    let destroyed = false;

    void onAgentCapabilitiesChanged(() => {
      bumpCapabilitiesVersion((value) => value + 1);
    }).then((unlisten) => {
      if (destroyed) {
        void unlisten();
        return;
      }
      dispose = unlisten;
    }).catch((error) => {
      console.error("[App] subscribe capabilities changed failed:", error);
    });

    return () => {
      destroyed = true;
      if (dispose) {
        void dispose();
      }
    };
  }, [bumpCapabilitiesVersion]);

  useEffect(() => {
    let dispose: UnlistenHandle | null = null;
    let destroyed = false;

    void onAgentWorkspaceFilesChanged(() => {
      bumpFilesVersion((value) => value + 1);
    }).then((unlisten) => {
      if (destroyed) {
        void unlisten();
        return;
      }
      dispose = unlisten;
    }).catch((error) => {
      console.error("[App] subscribe workspace files changed failed:", error);
    });

    return () => {
      destroyed = true;
      if (dispose) {
        void dispose();
      }
    };
  }, [bumpFilesVersion]);

  return (
    <TooltipProvider delayDuration={200}>
      <AppShell contextValue={contextValue} />
    </TooltipProvider>
  );
}

type UnlistenHandle = () => void | Promise<void>;
