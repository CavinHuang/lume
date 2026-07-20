import type { WikiCapabilityMatrix } from "@lume/shared";

export const WIKI_CAPABILITIES: WikiCapabilityMatrix = {
  phase: "A",
  runtimeStatus: "idle",
  uiMutation: true,
  askWikiRead: true,
  askWikiProposal: false,
  askWikiApply: false,
  ordinaryAgentRead: false,
  ordinaryAgentProposal: false,
  protectedRootGate: true,
  allowedRootSandbox: false,
  reason: "Wiki 读取可用；安全提案通道尚未完成，Agent 暂时不能创建 Wiki 草案。"
};

export function markWikiPhaseBAvailable(reason: string): void {
  WIKI_CAPABILITIES.phase = "B";
  WIKI_CAPABILITIES.runtimeStatus = "ready";
  WIKI_CAPABILITIES.ordinaryAgentRead = true;
  WIKI_CAPABILITIES.allowedRootSandbox = true;
  WIKI_CAPABILITIES.reason = reason;
}

export function markWikiProposalSecurityGateAvailable(): void {
  WIKI_CAPABILITIES.askWikiProposal = true;
  WIKI_CAPABILITIES.ordinaryAgentProposal = true;
  WIKI_CAPABILITIES.reason = WIKI_CAPABILITIES.phase === "B"
    ? "操作系统沙箱与 Wiki 安全提案通道已通过验证。"
    : "Wiki 安全提案通道已就绪；普通会话读取仍等待操作系统沙箱验证。";
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
