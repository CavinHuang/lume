import type { PiAgentRunParams, PiAgentRunResult, PiAgentRuntimeEmitter } from "./types";
import { createLogger } from "../../logger";
import { runRuntimeCoreAttempt } from "../runtime-core/attempt";

const activePiSessions = new Map<string, { abort: () => Promise<void> }>();
const log = createLogger("pi-agent-runner");
const DEFAULT_MAX_ATTEMPTS = 1;
const RETRY_DELAY_MS = 700;

export async function runPiAgent(
  params: PiAgentRunParams,
  emit: PiAgentRuntimeEmitter
): Promise<PiAgentRunResult> {
  const maxAttempts = resolveMaxAttempts();
  let attempt = 0;
  let lastResult: PiAgentRunResult = { status: "errored", errorMessage: "Pi Agent 未执行" };

  while (attempt < maxAttempts) {
    attempt += 1;
    const result = await runRuntimeCoreAttempt(params, emit, {
      registerAbort: (sessionId, abort) => {
        activePiSessions.set(sessionId, { abort });
      },
      unregisterAbort: (sessionId) => {
        activePiSessions.delete(sessionId);
      }
    });
    lastResult = result;
    if (result.status !== "errored") {
      return result;
    }
    const retryable = shouldRetryError(result.errorMessage);
    if (!retryable || attempt >= maxAttempts) {
      const message = result.errorMessage ?? "未知错误";
      emit.onError(`Pi Agent runtime 执行失败: ${message}`);
      return result;
    }

    log.warn("Pi Agent attempt 失败，准备重试", {
      sessionId: params.runtime.sessionId.slice(0, 8),
      attempt,
      maxAttempts,
      errorMessage: result.errorMessage
    });
    await sleep(RETRY_DELAY_MS);
  }

  const fallbackMessage = lastResult.errorMessage ?? "未知错误";
  emit.onError(`Pi Agent runtime 执行失败: ${fallbackMessage}`);
  return lastResult;
}

function resolveMaxAttempts(): number {
  const raw = process.env.LUME_PI_AGENT_MAX_ATTEMPTS?.trim();
  const parsed = raw ? Number(raw) : DEFAULT_MAX_ATTEMPTS;
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MAX_ATTEMPTS;
  }
  return Math.max(1, Math.min(3, Math.floor(parsed)));
}

function shouldRetryError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  const value = errorMessage.toLowerCase();
  return (
    value.includes("timeout") ||
    value.includes("timed out") ||
    value.includes("rate limit") ||
    value.includes("429") ||
    value.includes("temporar") ||
    value.includes("econnreset") ||
    value.includes("enotfound") ||
    value.includes("network")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
  });
}

export async function stopPiAgent(sessionId: string): Promise<boolean> {
  const active = activePiSessions.get(sessionId);
  if (!active) {
    return false;
  }
  await active.abort();
  activePiSessions.delete(sessionId);
  return true;
}

export function isPiAgentSessionActive(sessionId: string): boolean {
  return activePiSessions.has(sessionId);
}

export async function stopAllPiAgents(): Promise<void> {
  const all = Array.from(activePiSessions.entries());
  for (const [sessionId, active] of all) {
    await active.abort();
    activePiSessions.delete(sessionId);
  }
}
