// apps/sidecar/src/services/agent-runtime/agent-workspace-store-holder.ts
/**
 * 工作区存储读取端口（#289 分层切边）。
 *
 * 实现位于应用层 services/agent/agent-workspace-manager；内核经此 holder
 * 读取，组装层（index.ts）启动时注入。与 agent-thread-store-holder 同惯用法。
 */
import type { AgentWorkspace } from "@lume/shared";

export interface AgentWorkspaceStorePort {
  get(workspaceId: string): AgentWorkspace | undefined;
}

let store: AgentWorkspaceStorePort | undefined;

/** 安装进程级工作区存储实现（由应用组装层在启动时调用）。 */
export function registerAgentWorkspaceStore(port: AgentWorkspaceStorePort): void {
  store = port;
}

/** 读取工作区存储端口；未注册说明调用早于组装层装配，属装配缺陷。 */
export function workspaceStore(): AgentWorkspaceStorePort {
  if (!store) {
    throw new Error("AgentWorkspaceStore 未注册：组装层需在启动时调用 registerAgentWorkspaceStore");
  }
  return store;
}
