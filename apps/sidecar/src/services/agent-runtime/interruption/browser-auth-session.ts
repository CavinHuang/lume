import type {
  AgentBrowserAuthRequest,
  AgentBrowserAuthResponseInput,
  AgentBrowserAuthStatus
} from "@lume/shared";

export interface BrowserAuthWaitResult {
  status: AgentBrowserAuthStatus;
  values?: Record<string, string>;
}

const pendingBrowserAuthResolvers = new Map<
  string,
  {
    request: AgentBrowserAuthRequest;
    resolve: (result: BrowserAuthWaitResult) => void;
  }
>();

function pendingKey(threadId: string, requestId: string): string {
  return `${threadId}\u0000${requestId}`;
}

function stripSecrets(input: AgentBrowserAuthRequest): AgentBrowserAuthRequest {
  return {
    threadId: input.threadId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.originThreadId ? { originThreadId: input.originThreadId } : {}),
    ...(input.subagentRunId ? { subagentRunId: input.subagentRunId } : {}),
    ...(input.subagentLabel ? { subagentLabel: input.subagentLabel } : {}),
    requestId: input.requestId,
    origin: input.origin,
    ...(input.reason ? { reason: input.reason } : {}),
    expiresAt: input.expiresAt,
    fields: input.fields.map((field) => ({
      id: field.id,
      label: field.label,
      type: field.type,
      ...(field.autocomplete ? { autocomplete: field.autocomplete } : {}),
      ...(field.required !== undefined ? { required: field.required } : {})
    })),
    ...(input.browserSessionId ? { browserSessionId: input.browserSessionId } : {}),
    ...(input.browserTurnId ? { browserTurnId: input.browserTurnId } : {}),
    ...(input.tabId ? { tabId: input.tabId } : {})
  };
}

export function waitForBrowserAuthResponse(
  request: AgentBrowserAuthRequest,
  signal: AbortSignal,
  emit: (request: AgentBrowserAuthRequest) => void
): Promise<BrowserAuthWaitResult> {
  return new Promise((resolve) => {
    const safeRequest = stripSecrets(request);
    const key = pendingKey(safeRequest.threadId, safeRequest.requestId);

    const done = (result: BrowserAuthWaitResult): void => {
      pendingBrowserAuthResolvers.delete(key);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = (): void => {
      done({ status: "cancelled" });
    };

    const existing = pendingBrowserAuthResolvers.get(key);
    if (existing) {
      existing.resolve({ status: "cancelled" });
    }

    pendingBrowserAuthResolvers.set(key, {
      request: safeRequest,
      resolve: done
    });
    signal.addEventListener("abort", onAbort, { once: true });
    emit(safeRequest);
  });
}

export async function submitBrowserAuthResponse(input: AgentBrowserAuthResponseInput): Promise<boolean> {
  const pending = pendingBrowserAuthResolvers.get(pendingKey(input.threadId, input.requestId));
  if (!pending) return false;
  pending.resolve({
    status: input.status,
    ...(input.values ? { values: input.values } : {})
  });
  return true;
}

export function listPendingBrowserAuthRequests(): AgentBrowserAuthRequest[] {
  return Array.from(pendingBrowserAuthResolvers.values()).map((pending) => stripSecrets(pending.request));
}
