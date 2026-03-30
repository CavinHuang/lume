import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { AgentSidePanelTab } from "../AgentSidePanel";
import { resolveNextFileBrowserPanelState } from "../agent-side-panel-state";

export function useAgentSidePanelState(sessionId: string | null): {
  setSidePanelOpenMap: Dispatch<SetStateAction<Map<string, boolean>>>;
  setSidePanelTabMap: Dispatch<SetStateAction<Map<string, AgentSidePanelTab>>>;
  currentSidePanelOpen: boolean;
  currentSidePanelTab: AgentSidePanelTab;
  fileBrowserOpen: boolean;
  setCurrentSidePanelOpen: (open: boolean) => void;
  setCurrentSidePanelTab: (tab: AgentSidePanelTab) => void;
  handleToggleFileBrowser: () => void;
  openTeamPanel: () => void;
} {
  const [sidePanelOpenMap, setSidePanelOpenMap] = useState<Map<string, boolean>>(new Map());
  const [sidePanelTabMap, setSidePanelTabMap] = useState<Map<string, AgentSidePanelTab>>(new Map());

  const currentSidePanelOpen = sessionId ? sidePanelOpenMap.get(sessionId) ?? false : false;
  const currentSidePanelTab = sessionId ? sidePanelTabMap.get(sessionId) ?? "team" : "team";
  const fileBrowserOpen = currentSidePanelOpen && currentSidePanelTab === "files";

  const setCurrentSidePanelOpen = useCallback((open: boolean): void => {
    if (!sessionId) return;
    setSidePanelOpenMap((prev) => {
      const map = new Map(prev);
      map.set(sessionId, open);
      return map;
    });
  }, [sessionId]);

  const setCurrentSidePanelTab = useCallback((tab: AgentSidePanelTab): void => {
    if (!sessionId) return;
    setSidePanelTabMap((prev) => {
      const map = new Map(prev);
      map.set(sessionId, tab);
      return map;
    });
  }, [sessionId]);

  const handleToggleFileBrowser = useCallback((): void => {
    if (!sessionId) return;
    const next = resolveNextFileBrowserPanelState({
      open: currentSidePanelOpen,
      tab: currentSidePanelTab
    });
    setCurrentSidePanelTab(next.tab);
    setCurrentSidePanelOpen(next.open);
  }, [currentSidePanelOpen, currentSidePanelTab, sessionId, setCurrentSidePanelOpen, setCurrentSidePanelTab]);

  const openTeamPanel = useCallback((): void => {
    setCurrentSidePanelTab("team");
    setCurrentSidePanelOpen(true);
  }, [setCurrentSidePanelOpen, setCurrentSidePanelTab]);

  return {
    setSidePanelOpenMap,
    setSidePanelTabMap,
    currentSidePanelOpen,
    currentSidePanelTab,
    fileBrowserOpen,
    setCurrentSidePanelOpen,
    setCurrentSidePanelTab,
    handleToggleFileBrowser,
    openTeamPanel
  };
}
