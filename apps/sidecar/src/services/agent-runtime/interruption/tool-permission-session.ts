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
import { runtimePermissionSessionStore } from "../permissions/permission-session";
import { createLogger } from "../../infra/logger";

const log = createLogger("tool-permission-session");

const pendingToolPermissionResolvers = new Map<
  string,
  {
    threadId: string;
    approvalSessionId: string;
    request: AgentToolPermissionRequest;
    resolve: (decision: AgentToolPermissionDecision | null) => void | Promise<void>;
    timeout?: ReturnType<typeof setTimeout>;
  }
>();

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
  scope: AgentToolPermissionAllowScope = "exact"
): void {
  const normalized = fingerprint?.trim();
  if (!normalized) return;
  runtimePermissionSessionStore.grantFingerprintWithScope(threadId, normalized, scope);
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
  const pending = pendingToolPermissionResolvers.get(requestId);
  if (!pending) return;
  const normalized = approvalSessionId.trim();
  if (!normalized) return;
  pending.approvalSessionId = normalized;
  void updateToolApprovalSession({
    originalThreadId: pending.threadId,
    approvalThreadId: normalized,
    request: pending.request
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
  return new Promise((resolve) => {
    const done = async (decision: AgentToolPermissionDecision | null): Promise<void> => {
      const pending = pendingToolPermissionResolvers.get(request.requestId);
      if (pending?.timeout) {
        clearTimeout(pending.timeout);
      }
      pendingToolPermissionResolvers.delete(request.requestId);
      // abort/超时等无决策终结路径必须通知 UI 摘横幅，否则审批卡片悬挂到超时（幽灵审批）
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
      signal.removeEventListener("abort", onAbort);
      try {
        await resolveToolApprovalInterruption({
          threadId: request.threadId,
          requestId: request.requestId,
          decision
        });
      } catch (error) {
        // 持久化失败只降级冷启动恢复能力；resolve 必须仍被执行（在 try 之外），
        // 否则 timeout 已清除、abort 监听已摘除，等待方将无限悬挂
        log.warn("Failed to resolve tool approval interruption", {
          requestId: request.requestId,
          threadId: request.threadId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      resolve(decision);
    };

    const onAbort = (): void => {
      void done(null);
    };

    const existing = pendingToolPermissionResolvers.get(request.requestId);
    if (existing) {
      void existing.resolve(null);
    }

    const timeout = setTimeout(() => {
      options.onTimeout?.(request);
      void done(null);
    }, resolveTimeoutMs());
    if (typeof timeout === "object" && "unref" in timeout && typeof timeout.unref === "function") {
      timeout.unref();
    }

    pendingToolPermissionResolvers.set(request.requestId, {
      threadId: request.threadId,
      approvalSessionId: request.threadId,
      request,
      resolve: done,
      timeout
    });
    signal.addEventListener("abort", onAbort, { once: true });
    void persistToolApprovalInterruption(request).catch((error) => {
      log.warn("Failed to persist tool approval interruption", {
        requestId: request.requestId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    emit(request);
  });
}

export function submitToolPermissionDecision(input: AgentToolPermissionResponseInput): boolean {
  const shouldBypassThread = input.threadPermissionMode === "bypassPermissions" && input.decision !== "deny";
  const pending = pendingToolPermissionResolvers.get(input.requestId);
  if (!pending) {
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
    if (handled && input.decision === "allow_always" && persisted?.grantSuggestion?.fingerprint) {
      markToolFingerprintAllowed(
        persisted.originThreadId ?? persisted.threadId,
        persisted.grantSuggestion.fingerprint,
        input.allowAlwaysScope
      );
    }
    return handled;
  }
  if (pending.approvalSessionId !== input.threadId) {
    throw new Error("工具权限确认会话不匹配");
  }
  if (input.decision === "allow_always" && pending.request.canAllowAlways === false) {
    throw new Error("当前审批策略不允许始终允许");
  }
  if (shouldBypassThread && pending.request.canAllowAlways === false) {
    throw new Error("当前审批策略不允许切换为全部允许");
  }
  if (shouldBypassThread) {
    markToolPermissionSessionBypassed(input.threadId, pending.threadId, pending.request.originThreadId);
  }
  if (input.decision === "allow_always") {
    // #558:按用户选择的档位写宽指纹（缺省 exact 保持逐字节）
    markToolFingerprintAllowed(
      pending.request.originThreadId ?? pending.threadId,
      pending.request.grantSuggestion?.fingerprint,
      input.allowAlwaysScope
    );
  }
  void pending.resolve(input.decision);
  return true;
}

export function cancelPendingToolPermissionBySession(threadId: string): void {
  for (const [requestId, pending] of pendingToolPermissionResolvers) {
    if (pending.threadId !== threadId && pending.approvalSessionId !== threadId) continue;
    void resolveToolApprovalInterruption({
      threadId: pending.threadId,
      requestId,
      decision: null
    }).catch((error) => {
      log.warn("Failed to resolve cancelled tool approval interruption", {
        requestId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    void pending.resolve(null);
    pendingToolPermissionResolvers.delete(requestId);
  }
}

export function listPendingToolPermissionRequests(): AgentToolPermissionRequest[] {
  const liveRequests = Array.from(pendingToolPermissionResolvers.values()).map((pending) => ({
    ...pending.request,
    threadId: pending.approvalSessionId,
    ...(pending.request.originThreadId ? {} : (
      pending.threadId !== pending.approvalSessionId
        ? { originThreadId: pending.threadId }
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
