import type { AgentSidePanelTab } from "./AgentSidePanel";

export function resolveNextFileBrowserPanelState(input: {
  open: boolean;
  tab: AgentSidePanelTab;
}): {
  open: boolean;
  tab: AgentSidePanelTab;
} {
  if (input.open && input.tab === "files") {
    return {
      open: false,
      tab: "files"
    };
  }

  return {
    open: true,
    tab: "files"
  };
}
