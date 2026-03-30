import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { AgentWorkspace } from "@lume/shared";
import { ensureDefaultAgentWorkspace, getAgentWorkspaceCapabilities, listAgentWorkspaces } from "@/lib/desktop-api/agent";

interface CapabilityCounts {
  mcp: number;
  skills: number;
}

interface UseWorkspaceSidebarStateParams {
  mode: "chat" | "agent";
  currentWorkspaceId: string | null;
  agentWorkspaces: AgentWorkspace[];
  capabilitiesVersion: number;
  setAgentWorkspaces: Dispatch<SetStateAction<AgentWorkspace[]>>;
  setCurrentWorkspaceId: Dispatch<SetStateAction<string | null>>;
}

export function useWorkspaceSidebarState({
  mode,
  currentWorkspaceId,
  agentWorkspaces,
  capabilitiesVersion,
  setAgentWorkspaces,
  setCurrentWorkspaceId,
}: UseWorkspaceSidebarStateParams) {
  const [capabilities, setCapabilities] = useState<CapabilityCounts | null>(null);
  const [workspaceInitError, setWorkspaceInitError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        await ensureDefaultAgentWorkspace();
        const workspaces = await listAgentWorkspaces();
        setAgentWorkspaces(workspaces);
        setCurrentWorkspaceId((prev) => prev ?? workspaces[0]?.id ?? null);
        setWorkspaceInitError(null);
      } catch (error) {
        console.error("[LeftSidebar] 初始化工作区失败:", error);
        setWorkspaceInitError(`初始化工作区失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }, [setAgentWorkspaces, setCurrentWorkspaceId]);

  useEffect(() => {
    if (mode !== "agent" || !currentWorkspaceId) {
      setCapabilities(null);
      return;
    }
    const workspace = agentWorkspaces.find((item) => item.id === currentWorkspaceId);
    if (!workspace) return;
    void getAgentWorkspaceCapabilities(workspace.slug).then((next) => {
      const enabledMcp = next.mcpServers.filter((item) => item.enabled).length;
      setCapabilities({
        mcp: enabledMcp,
        skills: next.skills.length,
      });
    }).catch((error) => {
      console.error("[LeftSidebar] 加载工作区能力失败:", error);
      setCapabilities(null);
    });
  }, [mode, currentWorkspaceId, agentWorkspaces, capabilitiesVersion]);

  return {
    capabilities,
    workspaceInitError,
    setWorkspaceInitError,
  };
}
