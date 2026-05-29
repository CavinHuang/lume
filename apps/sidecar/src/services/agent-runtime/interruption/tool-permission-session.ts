import type {
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
import { listPendingRuntimeCoreInterruptions } from "./interruption-index";
import { runtimePermissionSessionStore } from "../permissions/permission-session";

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

export function markToolFingerprintAllowed(threadId: string, fingerprint?: string): void {
  const normalized = fingerprint?.trim();
  if (!normalized) return;
  runtimePermissionSessionStore.grantFingerprint(threadId, normalized);
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
  });
}

export function waitForToolPermissionDecision(
  request: AgentToolPermissionRequest,
  signal: AbortSignal,
  emit: (request: AgentToolPermissionRequest) => void,
  options: {
    onTimeout?: (request: AgentToolPermissionRequest) => void;
  } = {}
): Promise<AgentToolPermissionDecision | null> {
  return new Promise((resolve) => {
    const done = async (decision: AgentToolPermissionDecision | null): Promise<void> => {
      const pending = pendingToolPermissionResolvers.get(request.requestId);
      if (pending?.timeout) {
        clearTimeout(pending.timeout);
      }
      pendingToolPermissionResolvers.delete(request.requestId);
      signal.removeEventListener("abort", onAbort);
      await resolveToolApprovalInterruption({
        threadId: request.threadId,
        requestId: request.requestId,
        decision
      });
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
    void persistToolApprovalInterruption(request);
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
        persisted.grantSuggestion.fingerprint
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
