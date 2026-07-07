import type {
  AgentDesktopActionRequest,
  AgentDesktopActionResponseInput,
} from "@lume/shared";

const pending = new Map<string, {
  request: AgentDesktopActionRequest;
  resolve: (allowed: boolean) => void;
}>();

function key(threadId: string, requestId: string): string {
  return `${threadId}\u0000${requestId}`;
}

export function waitForDesktopActionDecision(
  request: AgentDesktopActionRequest,
  signal: AbortSignal,
  emit: (request: AgentDesktopActionRequest) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    const requestKey = key(request.threadId, request.requestId);
    const finish = (allowed: boolean): void => {
      pending.delete(requestKey);
      clearTimeout(expiryTimer);
      signal.removeEventListener("abort", onAbort);
      resolve(allowed);
    };
    const onAbort = (): void => finish(false);
    const expiresIn = Math.max(0, Date.parse(request.expiresAt) - Date.now());
    const expiryTimer = setTimeout(() => finish(false), expiresIn);
    pending.get(requestKey)?.resolve(false);
    pending.set(requestKey, { request: structuredClone(request), resolve: finish });
    signal.addEventListener("abort", onAbort, { once: true });
    emit(structuredClone(request));
  });
}

export function submitDesktopActionDecision(input: AgentDesktopActionResponseInput): boolean {
  const item = pending.get(key(input.threadId, input.requestId));
  if (!item) return false;
  item.resolve(input.decision === "allow_once");
  return true;
}

export function listPendingDesktopActionRequests(): AgentDesktopActionRequest[] {
  return Array.from(pending.values(), ({ request }) => structuredClone(request));
}
