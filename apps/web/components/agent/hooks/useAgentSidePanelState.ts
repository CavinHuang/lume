import { useCallback, useState } from "react";

export function useAgentSidePanelState(sessionId: string | null): {
  currentSidePanelOpen: boolean;
  fileBrowserOpen: boolean;
  setCurrentSidePanelOpen: (open: boolean) => void;
  handleToggleFileBrowser: () => void;
} {
  const [sidePanelOpenMap, setSidePanelOpenMap] = useState<Map<string, boolean>>(new Map());

  const currentSidePanelOpen = sessionId ? sidePanelOpenMap.get(sessionId) ?? true : true;
  const fileBrowserOpen = currentSidePanelOpen;

  const setCurrentSidePanelOpen = useCallback((open: boolean): void => {
    if (!sessionId) return;
    setSidePanelOpenMap((prev) => {
      const map = new Map(prev);
      map.set(sessionId, open);
      return map;
    });
  }, [sessionId]);

  const handleToggleFileBrowser = useCallback((): void => {
    if (!sessionId) return;
    setCurrentSidePanelOpen(!currentSidePanelOpen);
  }, [currentSidePanelOpen, sessionId, setCurrentSidePanelOpen]);

  return {
    currentSidePanelOpen,
    fileBrowserOpen,
    setCurrentSidePanelOpen,
    handleToggleFileBrowser
  };
}
