import type { WikiCapabilityMatrix } from "@lume/shared";

export const WIKI_CAPABILITIES: WikiCapabilityMatrix = {
  phase: "A",
  runtimeStatus: "idle",
  uiMutation: true,
  askWikiRead: true,
  askWikiProposal: false,
  askWikiApply: false,
  ordinaryAgentRead: true,
  ordinaryAgentProposal: false,
  protectedRootGate: true,
  allowedRootSandbox: false,
  reason: "受信任的本地 Agent 可按会话 scope 读取 Wiki；正式变更仍需安全提案通道和用户确认。"
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
    : "Wiki 读取与安全提案通道已就绪；正式变更仍需用户确认。";
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
