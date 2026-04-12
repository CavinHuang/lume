import { useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { IPC_PROTOCOL_VERSION } from "@lume/shared";
import {
  activeViewAtom,
  agentDraftByThreadIdAtom,
  agentSidePanelOpenMapAtom,
  appModeAtom,
  chatDraftByConversationIdAtom,
  currentAgentThreadIdAtom,
  currentAgentWorkspaceIdAtom,
  currentConversationIdAtom,
  promptSidebarOpenAtom,
  themeModeAtom,
  type ThemeMode,
  workspaceCapabilitiesVersionAtom,
  workspaceFilesVersionAtom
} from "./atoms";
import { AppShell } from "./components/app-shell/AppShell";
import { TooltipProvider } from "./components/ui/tooltip";
import { onAgentCapabilitiesChanged, onAgentWorkspaceFilesChanged } from "./lib/desktop-api/agent";
import { sidecarCall } from "./lib/desktop-api/core";
import { getPersistedUiState, updatePersistedUiState } from "./lib/desktop-api/system";

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

function toStringMap(value: unknown): Map<string, string> {
  if (typeof value !== "object" || value === null) {
    return new Map();
  }
  return new Map(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function toBooleanMap(value: unknown): Map<string, boolean> {
  if (typeof value !== "object" || value === null) {
    return new Map();
  }
  return new Map(
    Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")
  );
}

export default function App(): React.ReactElement {
  const mode = useAtomValue(themeModeAtom);
  const appMode = useAtomValue(appModeAtom);
  const activeView = useAtomValue(activeViewAtom);
  const agentDraftByThreadId = useAtomValue(agentDraftByThreadIdAtom);
  const agentSidePanelOpenMap = useAtomValue(agentSidePanelOpenMapAtom);
  const currentConversationId = useAtomValue(currentConversationIdAtom);
  const currentAgentThreadId = useAtomValue(currentAgentThreadIdAtom);
  const currentAgentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom);
  const chatDraftByConversationId = useAtomValue(chatDraftByConversationIdAtom);
  const promptSidebarOpen = useAtomValue(promptSidebarOpenAtom);
  const setActiveView = useSetAtom(activeViewAtom);
  const setAgentDraftByThreadId = useSetAtom(agentDraftByThreadIdAtom);
  const setAgentSidePanelOpenMap = useSetAtom(agentSidePanelOpenMapAtom);
  const setAppMode = useSetAtom(appModeAtom);
  const setChatDraftByConversationId = useSetAtom(chatDraftByConversationIdAtom);
  const setCurrentConversationId = useSetAtom(currentConversationIdAtom);
  const setCurrentAgentThreadId = useSetAtom(currentAgentThreadIdAtom);
  const setCurrentAgentWorkspaceId = useSetAtom(currentAgentWorkspaceIdAtom);
  const setPromptSidebarOpen = useSetAtom(promptSidebarOpenAtom);
  const bumpCapabilitiesVersion = useSetAtom(workspaceCapabilitiesVersionAtom);
  const bumpFilesVersion = useSetAtom(workspaceFilesVersionAtom);
  const [restoreReady, setRestoreReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getPersistedUiState().then((state) => {
      if (cancelled) return;
      setAppMode(state.appMode === "agent" ? "agent" : "chat");
      setActiveView(state.activeView === "settings" ? "settings" : "conversations");
      setCurrentConversationId(typeof state.currentConversationId === "string" ? state.currentConversationId : null);
      setCurrentAgentThreadId(typeof state.currentAgentThreadId === "string" ? state.currentAgentThreadId : null);
      setCurrentAgentWorkspaceId(
        typeof state.currentAgentWorkspaceId === "string" ? state.currentAgentWorkspaceId : null
      );
      setPromptSidebarOpen(state.promptSidebarOpen === true);
      setChatDraftByConversationId(toStringMap(state.chatDraftByConversationId));
      setAgentDraftByThreadId(toStringMap(state.agentDraftByThreadId));
      setAgentSidePanelOpenMap(toBooleanMap(state.agentSidePanelOpenByThreadId));
    }).catch((error) => {
      console.error("[App] 恢复 UI 状态失败:", error);
    }).finally(() => {
      if (!cancelled) {
        setRestoreReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    setActiveView,
    setAgentDraftByThreadId,
    setAgentSidePanelOpenMap,
    setAppMode,
    setChatDraftByConversationId,
    setCurrentAgentThreadId,
    setCurrentAgentWorkspaceId,
    setCurrentConversationId,
    setPromptSidebarOpen
  ]);

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

  useEffect(() => {
    if (!restoreReady) return;
    void updatePersistedUiState({
      appMode,
      activeView,
      currentConversationId,
      currentAgentThreadId,
      currentAgentWorkspaceId,
      promptSidebarOpen,
      chatDraftByConversationId: Object.fromEntries(chatDraftByConversationId),
      agentDraftByThreadId: Object.fromEntries(agentDraftByThreadId),
      agentSidePanelOpenByThreadId: Object.fromEntries(agentSidePanelOpenMap)
    }).catch((error) => {
      console.error("[App] 持久化 UI 状态失败:", error);
    });
  }, [
    activeView,
    agentDraftByThreadId,
    agentSidePanelOpenMap,
    appMode,
    chatDraftByConversationId,
    currentAgentThreadId,
    currentAgentWorkspaceId,
    currentConversationId,
    promptSidebarOpen,
    restoreReady
  ]);

  if (!restoreReady) {
    return <div className="h-screen w-screen bg-background" />;
  }

  return (
    <TooltipProvider delayDuration={200}>
      <AppShell />
    </TooltipProvider>
  );
}

type UnlistenHandle = () => void | Promise<void>;
