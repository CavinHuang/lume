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
  parentThreadId: string;
  parentPermissionMode?: AgentSendInput["permissionMode"];
  requestedSandbox?: "inherit" | "require";
}

type SubagentPermissionMode = NonNullable<AgentSendInput["permissionMode"]>;

// 特权序: bypassPermissions(4) > dontAsk ≡ auto(3) > acceptEdits(2) > default ≡ plan(1)
// plan 与 default 同档: plan 父级派生 default 子级时写操作仍逐次经用户审批，非静默提权
const SUBAGENT_PERMISSION_RANK: Record<string, number> = {
  default: 1,
  plan: 1,
  acceptEdits: 2,
  dontAsk: 3,
  auto: 3,
  bypassPermissions: 4
};

/**
 * 将模型请求的子代理权限模式钳制为不高于父线程模式。
 * - requested 为模型可控的工具入参，父级不可信时一律继承
 * - auto 归一为 dontAsk（engine 层与 SDK query 层对 auto 归一不一致，统一从严）
 * - 请求超过父级特权时降级为父级而非拒绝：agent 定义文件预置 mode 的合法派生不应被打断
 */
export function clampSubagentPermissionMode(
  requested: string | undefined,
  parent: SubagentPermissionMode | undefined
): SubagentPermissionMode | undefined {
  if (!requested) return parent;
  const normalized = requested === "auto" ? "dontAsk" : requested;
  const rank = SUBAGENT_PERMISSION_RANK[normalized];
  if (rank === undefined) return parent;
  const parentRank = SUBAGENT_PERMISSION_RANK[parent ?? "default"] ?? 1;
  return rank <= parentRank ? normalized as SubagentPermissionMode : parent;
}

export interface SubagentSpawnPolicyDecision {
  ok: boolean;
  error?: string;
  depth: number;
  rootThreadId: string;
  parentRunId?: string;
  childPermissionMode?: AgentSendInput["permissionMode"];
}

export function resolveSubagentSpawnPolicy(input: SubagentSpawnPolicyInput): SubagentSpawnPolicyDecision {
  const runRegistry = getSubagentRunRegistry();
  const parentRun = runRegistry.getLatestByChildThread(input.parentThreadId);
  const parentDepth = parentRun?.depth ?? 0;
  const depth = parentDepth + 1;
  const rootThreadId = parentRun?.rootThreadId ?? input.parentThreadId;
  const parentRunId = parentRun?.runId;
  const maxDepth = resolveEnvInt("LUME_SUBAGENT_MAX_DEPTH", DEFAULT_SUBAGENT_MAX_DEPTH, 1, 12);
  if (depth > maxDepth) {
    return {
      ok: false,
      error: `子任务深度超限: depth=${depth}, maxDepth=${maxDepth}`,
      depth,
      rootThreadId,
      parentRunId
    };
  }
  const maxFanout = resolveEnvInt("LUME_SUBAGENT_MAX_FANOUT", DEFAULT_SUBAGENT_MAX_FANOUT, 1, 64);
  const activeFanout = runRegistry.countActiveByParentSession(input.parentThreadId);
  if (activeFanout >= maxFanout) {
    return {
      ok: false,
      error: `子任务并发扇出超限: active=${activeFanout}, maxFanout=${maxFanout}`,
      depth,
      rootThreadId,
      parentRunId
    };
  }

  const sandbox = input.requestedSandbox === "require" ? "require" : "inherit";
  const childPermissionMode = sandbox === "require" ? input.parentPermissionMode : input.parentPermissionMode;

  return {
    ok: true,
    depth,
    rootThreadId,
    parentRunId,
    childPermissionMode
  };
}

