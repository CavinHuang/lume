import type {
  AgentToolPermissionDecision,
  AgentToolPermissionRequest,
  AgentToolPermissionResponseInput
} from "@lume/shared";

const pendingToolPermissionResolvers = new Map<
  string,
  {
    threadId: string;
    approvalSessionId: string;
    resolve: (decision: AgentToolPermissionDecision | null) => void;
    timeout?: ReturnType<typeof setTimeout>;
  }
>();

const sessionAlwaysAllowedTools = new Map<string, Set<string>>();
const DEFAULT_TOOL_PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;

function resolveTimeoutMs(): number {
  const raw = process.env.LUME_TOOL_PERMISSION_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TOOL_PERMISSION_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_TOOL_PERMISSION_TIMEOUT_MS;
  return Math.max(15_000, Math.min(60 * 60 * 1000, Math.floor(parsed)));
}

export function isToolAlwaysAllowed(threadId: string, toolName: string): boolean {
  const allowed = sessionAlwaysAllowedTools.get(threadId);
  if (!allowed) return false;
  return allowed.has(toolName.trim());
}

export function markToolAlwaysAllowed(threadId: string, toolName: string): void {
  const normalized = toolName.trim();
  if (!normalized) return;
  let allowed = sessionAlwaysAllowedTools.get(threadId);
  if (!allowed) {
    allowed = new Set<string>();
    sessionAlwaysAllowedTools.set(threadId, allowed);
  }
  allowed.add(normalized);
}

export function clearToolPermissionSession(threadId: string): void {
  sessionAlwaysAllowedTools.delete(threadId);
  cancelPendingToolPermissionBySession(threadId);
}

export function setToolPermissionApprovalSession(requestId: string, approvalSessionId: string): void {
  const pending = pendingToolPermissionResolvers.get(requestId);
  if (!pending) return;
  const normalized = approvalSessionId.trim();
  if (!normalized) return;
  pending.approvalSessionId = normalized;
}

export function waitForToolPermissionDecision(
  request: AgentToolPermissionRequest,
  signal: AbortSignal,
  emit: (request: AgentToolPermissionRequest) => void
): Promise<AgentToolPermissionDecision | null> {
  return new Promise((resolve) => {
    const done = (decision: AgentToolPermissionDecision | null): void => {
      const pending = pendingToolPermissionResolvers.get(request.requestId);
      if (pending?.timeout) {
        clearTimeout(pending.timeout);
      }
      pendingToolPermissionResolvers.delete(request.requestId);
      signal.removeEventListener("abort", onAbort);
      resolve(decision);
    };

    const onAbort = (): void => {
      done(null);
    };

    const existing = pendingToolPermissionResolvers.get(request.requestId);
    if (existing) {
      existing.resolve(null);
    }

    const timeout = setTimeout(() => {
      done(null);
    }, resolveTimeoutMs());
    if (typeof timeout === "object" && "unref" in timeout && typeof timeout.unref === "function") {
      timeout.unref();
    }

    pendingToolPermissionResolvers.set(request.requestId, {
      threadId: request.threadId,
      approvalSessionId: request.threadId,
      resolve: done,
      timeout
    });
    signal.addEventListener("abort", onAbort, { once: true });
    emit(request);
  });
}

export function submitToolPermissionDecision(input: AgentToolPermissionResponseInput): boolean {
  const pending = pendingToolPermissionResolvers.get(input.requestId);
  if (!pending) {
    return false;
  }
  if (pending.approvalSessionId !== input.threadId) {
    throw new Error("工具权限确认会话不匹配");
  }
  pending.resolve(input.decision);
  return true;
}

export function cancelPendingToolPermissionBySession(threadId: string): void {
  for (const [requestId, pending] of pendingToolPermissionResolvers) {
    if (pending.threadId !== threadId && pending.approvalSessionId !== threadId) continue;
    pending.resolve(null);
    pendingToolPermissionResolvers.delete(requestId);
  }
}


