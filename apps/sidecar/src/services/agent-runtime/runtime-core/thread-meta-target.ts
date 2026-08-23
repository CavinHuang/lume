import type { AgentRuntimeRunParams } from "./types";
import { getRuntimeHostPorts } from "../host-ports";
import type { AgentThreadMetaUpdates } from "../host-ports";

export function resolvePersistedAgentThreadId(
  runtime: AgentRuntimeRunParams["runtime"]
): string | undefined {
  if (runtime.deliveryThreadId && getRuntimeHostPorts().getThreadMeta(runtime.deliveryThreadId)) {
    return runtime.deliveryThreadId;
  }
  if (getRuntimeHostPorts().getThreadMeta(runtime.sessionId)) {
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
  getRuntimeHostPorts().tryUpdateThreadMeta(targetThreadId, updates);
}
