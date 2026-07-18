import type { WikiCapabilityMatrix } from "@lume/shared";

export const WIKI_CAPABILITIES: WikiCapabilityMatrix = {
  phase: "A",
  runtimeStatus: "idle",
  uiMutation: true,
  askWikiReadOnly: true,
  ordinaryAgentRead: false,
  agentProposals: false,
  protectedRootGate: true,
  allowedRootSandbox: false,
  reason: "全局 protected-root 硬门已启用；Bash、node-repl 与外部进程的操作系统级允许根沙箱尚未验收，因此保持 Phase A，不给普通编码会话附加 Wiki scope。"
};

export function markWikiPhaseBAvailable(reason: string): void {
  WIKI_CAPABILITIES.phase = "B";
  WIKI_CAPABILITIES.runtimeStatus = "ready";
  WIKI_CAPABILITIES.ordinaryAgentRead = true;
  WIKI_CAPABILITIES.agentProposals = true;
  WIKI_CAPABILITIES.allowedRootSandbox = true;
  WIKI_CAPABILITIES.reason = reason;
}

export function markWikiPhaseAUnavailable(reason: string): void {
  if (WIKI_CAPABILITIES.phase === "B") return;
  WIKI_CAPABILITIES.runtimeStatus = "unavailable";
  WIKI_CAPABILITIES.reason = reason;
}

export function markWikiRuntimePreparing(): void {
  if (WIKI_CAPABILITIES.phase === "B") return;
  WIKI_CAPABILITIES.runtimeStatus = "preparing";
  WIKI_CAPABILITIES.reason = "正在验证操作系统隔离与本机工具链";
}
