import { getAgentSessionMeta } from "../../agent-session-manager";

function normalizeSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export interface ResolveSubagentThreadBindingInput {
  parentSessionId: string;
  childSessionId: string;
  threadRequested?: boolean;
  requestedDeliverySessionId?: string;
}

export interface ResolvedSubagentThreadBinding {
  deliverySessionId: string;
  threadRequested: boolean;
  threadBound: boolean;
}

/**
 * Lume 当前版本先提供 sidecar 层抽象：
 * - delivery target 可重定向到指定 session
 * - threadRequested 仅作为绑定意图标记，后续渠道插件可接入真正线程绑定
 */
export function resolveSubagentThreadBinding(
  input: ResolveSubagentThreadBindingInput
): ResolvedSubagentThreadBinding {
  const requestedDelivery = normalizeSessionId(input.requestedDeliverySessionId);
  const resolvedDelivery = requestedDelivery && getAgentSessionMeta(requestedDelivery)
    ? requestedDelivery
    : input.parentSessionId;
  const threadRequested = input.threadRequested === true;
  const threadBound = threadRequested;
  void input.childSessionId;
  return {
    deliverySessionId: resolvedDelivery,
    threadRequested,
    threadBound
  };
}

export function releaseSubagentThreadBinding(_input: {
  runId: string;
  childSessionId: string;
  deliverySessionId: string;
  threadBound?: boolean;
}): void {
  // 当前 sidecar 版本无外部线程资源需要释放，保留接口用于后续渠道实现。
}
