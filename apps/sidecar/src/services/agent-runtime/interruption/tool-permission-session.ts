import type {
  AgentToolPermissionAllowScope,
  AgentToolPermissionDecision,
  AgentToolPermissionRequest,
  AgentToolPermissionResponseInput
} from "@lume/shared";
import {
  persistToolApprovalInterruption,
  resolvePersistedToolApprovalInterruption,
  resolveToolApprovalInterruption,
  updateToolApprovalSession
} from "./approval-service";
import { listPendingRuntimeCoreInterruptions } from "./interruption-pending";
import { runtimePermissionSessionStore, type GrantOrigin } from "../permissions/permission-session";
import { PendingRequestRegistry } from "./pending-request-registry";
import { createLogger } from "../../infra/logger";

const log = createLogger("tool-permission-session");

interface ToolPermissionPendingMeta {
  threadId: string;
  approvalSessionId: string;
  request: AgentToolPermissionRequest;
}

// #580:Map+timeout+resolve 手写三联收编进 PendingRequestRegistry。
const pendingToolPermissionResolvers =
  new PendingRequestRegistry<string, AgentToolPermissionDecision | null, ToolPermissionPendingMeta>();

const DEFAULT_TOOL_PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;

function resolveTimeoutMs(): number {
  const raw = process.env.LUME_TOOL_PERMISSION_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TOOL_PERMISSION_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_TOOL_PERMISSION_TIMEOUT_MS;
  return Math.max(15_000, Math.min(60 * 60 * 1000, Math.floor(parsed)));
}

export function markToolFingerprintAllowed(
  threadId: string,
  fingerprint?: string,
  scope: AgentToolPermissionAllowScope = "exact",
  origin?: GrantOrigin
): AgentToolPermissionAllowScope {
  const normalized = fingerprint?.trim();
  if (!normalized) return "exact";
  // #775：origin.workspaceSlug 在场时同步镜像 workspace 持久授权并落盘
  return runtimePermissionSessionStore.grantFingerprintWithScope(threadId, normalized, scope, origin);
}

export function markToolPermissionSessionBypassed(...threadIds: Array<string | undefined>): void {
  for (const threadId of threadIds) {
    const normalized = threadId?.trim();
    if (!normalized) continue;
    runtimePermissionSessionStore.bypass(normalized);
  }
}

export function clearToolPermissionSession(threadId: string): void {
  runtimePermissionSessionStore.clear(threadId);
  cancelPendingToolPermissionBySession(threadId);
}

export function setToolPermissionApprovalSession(requestId: string, approvalSessionId: string): void {
  const meta = pendingToolPermissionResolvers.getMeta(requestId);
  if (!meta) return;
  const normalized = approvalSessionId.trim();
  if (!normalized) return;
  pendingToolPermissionResolvers.updateMeta(requestId, { approvalSessionId: normalized });
  void updateToolApprovalSession({
    originalThreadId: meta.threadId,
    approvalThreadId: normalized,
    request: meta.request
  }).catch((error) => {
    log.warn("Failed to update tool approval session", {
      requestId,
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

export function waitForToolPermissionDecision(
  request: AgentToolPermissionRequest,
  signal: AbortSignal,
  emit: (request: AgentToolPermissionRequest) => void,
  options: {
    onTimeout?: (request: AgentToolPermissionRequest) => void;
    onCancelled?: (request: AgentToolPermissionRequest) => void;
  } = {}
): Promise<AgentToolPermissionDecision | null> {
  // 二轮复审 P2-3(与上游 #781 预 abort 守卫同款语义):死信号场景不得发审批卡、
  // 不得持久化——否则 registry 短路 resolve 的持久化清理读不到尚未落盘的 pending
  // 记录,runContinuation 残留 waiting_for_interruption(desktop 收到死审批卡)。
  if (signal.aborted) {
    return Promise.resolve(null);
  }
  // 上游合并移植(#781 幽灵审批修复):无决策终结(cancel/abort/超时)路径
  // 必须通知 UI 摘横幅;幂等性由 Registry settle 单出口守卫保证。
  const promise = pendingToolPermissionResolvers.wait(request.requestId, {
    meta: { threadId: request.threadId, approvalSessionId: request.threadId, request },
    timeoutMs: resolveTimeoutMs(),
    signal,
    timeoutValue: () => null,
    abortValue: () => null,
    supersededValue: () => null,
    onTimeout: () => options.onTimeout?.(request),
    beforeResolve: async (decision) => {
      // 上游 #781 移植:abort/超时/cancelWhere 等无决策路径同步通知 UI 摘横幅,
      // 否则审批卡片悬挂到超时(幽灵审批)。
      if (decision === null) {
        try {
          options.onCancelled?.(request);
        } catch (error) {
          log.warn("onCancelled callback failed", {
            requestId: request.requestId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      try {
        await resolveToolApprovalInterruption({
          threadId: request.threadId,
          requestId: request.requestId,
          decision
        });
      } catch (error) {
        // 持久化失败只降级冷启动恢复能力;resolve 必须仍被执行(Registry 保证)
        log.warn("Failed to resolve tool approval interruption", {
          requestId: request.requestId,
          threadId: request.threadId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  });
  void persistToolApprovalInterruption(request).catch((error) => {
    log.warn("Failed to persist tool approval interruption", {
      requestId: request.requestId,
      error: error instanceof Error ? error.message : String(error)
    });
  });
  emit(request);
  return promise;
}

export interface ToolPermissionSubmitResult {
  handled: boolean;
  /** allow_always 实际生效档（宽档被否决时降级 exact），供 UI 如实回执 */
  effectiveScope?: AgentToolPermissionAllowScope;
}

export function submitToolPermissionDecision(input: AgentToolPermissionResponseInput): ToolPermissionSubmitResult {
  const shouldBypassThread = input.threadPermissionMode === "bypassPermissions" && input.decision !== "deny";
  const meta = pendingToolPermissionResolvers.getMeta(input.requestId);
  if (!meta) {
    const persisted = findPersistedToolPermissionRequest(input.threadId, input.requestId);
    if (input.decision === "allow_always" && persisted?.canAllowAlways === false) {
      throw new Error("当前审批策略不允许始终允许");
    }
    if (shouldBypassThread && persisted?.canAllowAlways === false) {
      throw new Error("当前审批策略不允许切换为全部允许");
    }
    const handled = resolvePersistedToolApprovalInterruption({
      approvalThreadId: input.threadId,
      requestId: input.requestId,
      decision: input.decision
    });
    if (handled && shouldBypassThread) {
      markToolPermissionSessionBypassed(input.threadId, persisted?.threadId, persisted?.originThreadId);
    }
    let effectiveScope: AgentToolPermissionAllowScope | undefined;
    if (handled && input.decision === "allow_always" && persisted?.grantSuggestion?.fingerprint) {
      effectiveScope = markToolFingerprintAllowed(
        persisted.originThreadId ?? persisted.threadId,
        persisted.grantSuggestion.fingerprint,
        input.allowAlwaysScope,
        { workspaceSlug: persisted.workspaceSlug, toolName: persisted.toolName }
      );
    }
    return { handled, ...(effectiveScope ? { effectiveScope } : {}) };
  }
  if (meta.approvalSessionId !== input.threadId) {
    throw new Error("工具权限确认会话不匹配");
  }
  if (input.decision === "allow_always" && meta.request.canAllowAlways === false) {
    throw new Error("当前审批策略不允许始终允许");
  }
  if (shouldBypassThread && meta.request.canAllowAlways === false) {
    throw new Error("当前审批策略不允许切换为全部允许");
  }
  if (shouldBypassThread) {
    markToolPermissionSessionBypassed(input.threadId, meta.threadId, meta.request.originThreadId);
  }
  let effectiveScope: AgentToolPermissionAllowScope | undefined;
  if (input.decision === "allow_always") {
    // #558:按用户选择的档位写宽指纹（缺省 exact 保持逐字节）
    // #775：请求携带 workspaceSlug 时落盘为 workspace 级持久授权
    effectiveScope = markToolFingerprintAllowed(
      meta.request.originThreadId ?? meta.threadId,
      meta.request.grantSuggestion?.fingerprint,
      input.allowAlwaysScope,
      { workspaceSlug: meta.request.workspaceSlug, toolName: meta.request.toolName }
    );
  }
  pendingToolPermissionResolvers.settle(input.requestId, input.decision);
  return { handled: true, ...(effectiveScope ? { effectiveScope } : {}) };
}

export function cancelPendingToolPermissionBySession(threadId: string): void {
  pendingToolPermissionResolvers.cancelWhere(
    (meta) => meta.threadId === threadId || meta.approvalSessionId === threadId,
    () => null
  );
}

export function listPendingToolPermissionRequests(): AgentToolPermissionRequest[] {
  const liveRequests = pendingToolPermissionResolvers.list().map(({ meta }) => ({
    ...meta.request,
    threadId: meta.approvalSessionId,
    ...(meta.request.originThreadId ? {} : (
      meta.threadId !== meta.approvalSessionId
        ? { originThreadId: meta.threadId }
        : {}
    ))
  }));
  mergePersistedToolPermissionRequests(liveRequests);
  return liveRequests;
}

function findPersistedToolPermissionRequest(threadId: string, requestId: string): AgentToolPermissionRequest | null {
  for (const interruption of listPendingRuntimeCoreInterruptions()) {
    if (interruption.type !== "tool_approval" && interruption.type !== "automation_approval") continue;
    const payload = interruption.payload as AgentToolPermissionRequest;
    if (payload?.requestId === requestId && interruption.threadId === threadId) {
      return payload;
    }
  }
  return null;
}

function mergePersistedToolPermissionRequests(target: AgentToolPermissionRequest[]): void {
  const seen = new Set(target.map((request) => request.requestId));
  const persisted = listPendingRuntimeCoreInterruptions();
  for (const interruption of persisted) {
    if (interruption.type !== "tool_approval" && interruption.type !== "automation_approval") continue;
    const payload = interruption.payload as AgentToolPermissionRequest;
    if (!payload?.requestId || seen.has(payload.requestId)) continue;
    seen.add(payload.requestId);
    target.push(payload);
  }
}
