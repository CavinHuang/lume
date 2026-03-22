import type { AgentSendInput } from "@lume/shared";
import { getSubagentRunRegistry } from "./subagent-run-registry";

const DEFAULT_SUBAGENT_MAX_DEPTH = 3;
const DEFAULT_SUBAGENT_MAX_FANOUT = 6;

function resolveEnvInt(name: string, fallback: number, min = 1, max = 100): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export interface SubagentSpawnPolicyInput {
  parentSessionId: string;
  parentPermissionMode?: AgentSendInput["permissionMode"];
  requestedSandbox?: "inherit" | "require";
}

export interface SubagentSpawnPolicyDecision {
  ok: boolean;
  error?: string;
  depth: number;
  rootSessionId: string;
  parentRunId?: string;
  childPermissionMode?: AgentSendInput["permissionMode"];
}

export function resolveSubagentSpawnPolicy(input: SubagentSpawnPolicyInput): SubagentSpawnPolicyDecision {
  const runRegistry = getSubagentRunRegistry();
  const parentRun = runRegistry.getLatestByChildSession(input.parentSessionId);
  const parentDepth = parentRun?.depth ?? 0;
  const depth = parentDepth + 1;
  const rootSessionId = parentRun?.rootSessionId ?? input.parentSessionId;
  const parentRunId = parentRun?.runId;
  const maxDepth = resolveEnvInt("LUME_SUBAGENT_MAX_DEPTH", DEFAULT_SUBAGENT_MAX_DEPTH, 1, 12);
  if (depth > maxDepth) {
    return {
      ok: false,
      error: `子任务深度超限: depth=${depth}, maxDepth=${maxDepth}`,
      depth,
      rootSessionId,
      parentRunId
    };
  }
  const maxFanout = resolveEnvInt("LUME_SUBAGENT_MAX_FANOUT", DEFAULT_SUBAGENT_MAX_FANOUT, 1, 64);
  const activeFanout = runRegistry.countActiveByParentSession(input.parentSessionId);
  if (activeFanout >= maxFanout) {
    return {
      ok: false,
      error: `子任务并发扇出超限: active=${activeFanout}, maxFanout=${maxFanout}`,
      depth,
      rootSessionId,
      parentRunId
    };
  }

  const sandbox = input.requestedSandbox === "require" ? "require" : "inherit";
  const inheritedPermission = input.parentPermissionMode ?? "default";
  const childPermissionMode = sandbox === "require" ? inheritedPermission : inheritedPermission;

  return {
    ok: true,
    depth,
    rootSessionId,
    parentRunId,
    childPermissionMode
  };
}
