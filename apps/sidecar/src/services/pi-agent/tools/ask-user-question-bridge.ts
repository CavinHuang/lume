import type {
  AgentAskUserQuestionQuestion,
  AgentAskUserQuestionRequest,
  AgentAskUserQuestionResponseInput
} from "@lume/shared";

const pendingPiAskUserQuestionResolvers = new Map<
  string,
  {
    sessionId: string;
    approvalSessionId: string;
    resolve: (result: AskUserQuestionWaitResult) => void;
    timeout?: ReturnType<typeof setTimeout>;
  }
>();

const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;

export interface AskUserQuestionWaitResult {
  status: "answered" | "canceled" | "aborted" | "timeout";
  answers: Record<string, string> | null;
}

export function setAskUserQuestionApprovalSession(toolUseId: string, approvalSessionId: string): void {
  const pending = pendingPiAskUserQuestionResolvers.get(toolUseId);
  if (!pending) return;
  const normalized = approvalSessionId.trim();
  if (!normalized) return;
  pending.approvalSessionId = normalized;
}

function resolveAskTimeoutMs(): number {
  const raw = process.env.LUME_ASK_USER_QUESTION_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_ASK_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_ASK_TIMEOUT_MS;
  const minTimeoutMs = process.env.LUME_ASK_USER_QUESTION_ALLOW_LOW_TIMEOUT === "1" ? 10 : 30_000;
  return Math.max(minTimeoutMs, Math.min(60 * 60 * 1000, Math.floor(parsed)));
}

export function waitForPiAskUserQuestionAnswers(
  sessionId: string,
  toolUseId: string,
  questions: AgentAskUserQuestionQuestion[],
  signal: AbortSignal,
  emit: (request: AgentAskUserQuestionRequest) => void
): Promise<AskUserQuestionWaitResult> {
  return new Promise((resolve) => {
    const done = (result: AskUserQuestionWaitResult): void => {
      const pending = pendingPiAskUserQuestionResolvers.get(toolUseId);
      if (pending?.timeout) {
        clearTimeout(pending.timeout);
      }
      pendingPiAskUserQuestionResolvers.delete(toolUseId);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = (): void => {
      done({ status: "aborted", answers: null });
    };

    const existing = pendingPiAskUserQuestionResolvers.get(toolUseId);
    if (existing) {
      existing.resolve({ status: "canceled", answers: null });
    }
    const timeout = setTimeout(() => {
      done({ status: "timeout", answers: null });
    }, resolveAskTimeoutMs());
    if (typeof timeout === "object" && "unref" in timeout && typeof timeout.unref === "function") {
      timeout.unref();
    }
    pendingPiAskUserQuestionResolvers.set(toolUseId, {
      sessionId,
      approvalSessionId: sessionId,
      resolve: done,
      timeout
    });
    signal.addEventListener("abort", onAbort, { once: true });
    emit({
      sessionId,
      toolUseId,
      questions
    });
  });
}

export function submitPiAskUserQuestionAnswers(input: AgentAskUserQuestionResponseInput): boolean {
  const pending = pendingPiAskUserQuestionResolvers.get(input.toolUseId);
  if (!pending) {
    return false;
  }
  if (pending.approvalSessionId !== input.sessionId) {
    throw new Error("AskUserQuestion 会话不匹配");
  }
  if (input.canceled) {
    pending.resolve({ status: "canceled", answers: null });
    return true;
  }
  pending.resolve({ status: "answered", answers: input.answers ?? {} });
  return true;
}

export function cancelPendingPiAskUserQuestionBySession(sessionId: string): void {
  for (const [toolUseId, pending] of pendingPiAskUserQuestionResolvers) {
    if (pending.sessionId !== sessionId && pending.approvalSessionId !== sessionId) {
      continue;
    }
    pending.resolve({ status: "canceled", answers: null });
    pendingPiAskUserQuestionResolvers.delete(toolUseId);
  }
}
