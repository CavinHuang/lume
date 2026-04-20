import { getAgentThreadMeta, updateAgentThreadMeta } from "../../agent/agent-thread-manager";
import type { PiAgentRunParams } from "../runner/types";

export function resolvePersistedAgentThreadId(
  runtime: PiAgentRunParams["runtime"]
): string | undefined {
  if (runtime.deliveryThreadId && getAgentThreadMeta(runtime.deliveryThreadId)) {
    return runtime.deliveryThreadId;
  }
  if (getAgentThreadMeta(runtime.sessionId)) {
    return runtime.sessionId;
  }
  return undefined;
}

export function updateRuntimeThreadMetaIfPresent(
  runtime: PiAgentRunParams["runtime"],
  updates: Parameters<typeof updateAgentThreadMeta>[1]
): void {
  const targetThreadId = resolvePersistedAgentThreadId(runtime);
  if (!targetThreadId) {
    return;
  }
  updateAgentThreadMeta(targetThreadId, updates);
}
