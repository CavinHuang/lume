import { threadStore, type AgentThreadMetaUpdates } from "../agent-thread-store-holder";
import type { AgentRuntimeRunParams } from "../runner/types";

export function resolvePersistedAgentThreadId(
  runtime: AgentRuntimeRunParams["runtime"]
): string | undefined {
  if (runtime.deliveryThreadId && threadStore().getMeta(runtime.deliveryThreadId)) {
    return runtime.deliveryThreadId;
  }
  if (threadStore().getMeta(runtime.sessionId)) {
    return runtime.sessionId;
  }
  return undefined;
}

export function updateRuntimeThreadMetaIfPresent(
  runtime: AgentRuntimeRunParams["runtime"],
  updates: AgentThreadMetaUpdates
): void {
  const targetThreadId = resolvePersistedAgentThreadId(runtime);
  if (!targetThreadId) {
    return;
  }
  threadStore().tryUpdateMeta(targetThreadId, updates);
}
