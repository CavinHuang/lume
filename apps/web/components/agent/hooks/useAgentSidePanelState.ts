import { useCallback, useState } from "react";

export function useAgentSidePanelState(sessionId: string | null): {
  currentSidePanelOpen: boolean;
  setCurrentSidePanelOpen: (open: boolean) => void;
} {
  const [sidePanelOpenMap, setSidePanelOpenMap] = useState<Map<string, boolean>>(new Map());

  const currentSidePanelOpen = sessionId ? sidePanelOpenMap.get(sessionId) ?? true : true;

  const setCurrentSidePanelOpen = useCallback((open: boolean): void => {
    if (!sessionId) return;
    setSidePanelOpenMap((prev) => {
      const map = new Map(prev);
      map.set(sessionId, open);
      return map;
    });
  }, [sessionId]);

  return {
    currentSidePanelOpen,
    setCurrentSidePanelOpen
  };
}
