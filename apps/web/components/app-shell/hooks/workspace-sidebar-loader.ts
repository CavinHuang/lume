import type { AgentWorkspace } from "@lume/shared";
import { ensureDefaultAgentWorkspace, listAgentWorkspaces } from "../../../lib/desktop-api/agent";

export interface WorkspaceSidebarSnapshot {
  workspaces: AgentWorkspace[];
}

// React StrictMode 在开发环境会重复触发初始化，复用同一批 RPC 以避免 sidecar 冷启动阶段被重复压测。
let pendingWorkspaceSnapshot: Promise<WorkspaceSidebarSnapshot> | null = null;

export function loadWorkspaceSidebarSnapshot(): Promise<WorkspaceSidebarSnapshot> {
  if (!pendingWorkspaceSnapshot) {
    pendingWorkspaceSnapshot = (async () => {
      await ensureDefaultAgentWorkspace();
      const workspaces = await listAgentWorkspaces();
      return { workspaces };
    })().finally(() => {
      pendingWorkspaceSnapshot = null;
    });
  }

  return pendingWorkspaceSnapshot;
}
