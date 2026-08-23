import type { AgentSubagentCompletionEvent } from "@lume/shared";
import {
  getAgentThreadMeta,
  updateAgentThreadMeta
} from "../../agent/agent-thread-manager";
import { createLogger } from "../../infra/logger";
import { subagentLogFields } from "./subagent-run-registry";
import type { SubagentRun } from "./subagent-run-types";
import { releaseSubagentThreadBinding } from "./subagent-thread-binding";

// ─── Announce service ───

const ANNOUNCE_MAX_RETRIES = 3;
const ANNOUNCE_RETRY_DELAYS_MS = [40, 120, 320] as const;
const log = createLogger("subagent-announce");
const listeners = new Set<(event: AgentSubagentCompletionEvent) => void>();
const ANNOUNCE_OUTPUT_SUMMARY_MAX_CHARS = 280;

export interface SubagentAnnounceResult {
  delivered: boolean;
  attempts: number;
  event?: AgentSubagentCompletionEvent;
  error?: string;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...(truncated)...`;
}

function formatStatusLabel(status: SubagentRun["status"]): string {
  switch (status) {
    case "completed":
      return "completed";
    case "errored":
      return "errored";
    case "aborted":
      return "aborted";
    case "timed_out":
      return "timed_out";
    case "canceled":
      return "canceled";
    case "running":
      return "running";
    default:
      return "accepted";
  }
}

function buildAnnounceEvent(run: SubagentRun, threadId: string): AgentSubagentCompletionEvent {
  const output = typeof run.outcome?.output === "string" ? run.outcome.output.trim() : "";
  const error = typeof run.outcome?.error === "string" ? run.outcome.error.trim() : "";
  const label = (run.requestedAgentId?.trim() || run.label?.trim() || "子任务").slice(0, 60);
  return {
    threadId,
    runId: run.runId,
    childThreadId: run.childThreadId,
    ...(run.parentToolUseId ? { parentToolUseId: run.parentToolUseId } : {}),
    label,
    status: run.status,
    outputText: output ? truncateText(output, ANNOUNCE_OUTPUT_SUMMARY_MAX_CHARS) : undefined,
    errorText: error ? truncateText(error, 600) : undefined
  };
}

function waitRetry(attempt: number): Promise<void> {
  const delay = ANNOUNCE_RETRY_DELAYS_MS[Math.max(0, attempt - 1)];
  if (!delay) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delay);
    if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
  });
}

export async function announceSubagentCompletion(params: {
  run: SubagentRun;
}): Promise<SubagentAnnounceResult> {
  const run = params.run;
  const targetSessionId = run.deliveryThreadId ?? run.parentThreadId;
  const targetMeta = getAgentThreadMeta(targetSessionId);
  if (!targetMeta) {
    log.warn("announce skipped: target session not found", subagentLogFields(run, {
      event: "announce_skipped",
      deliveryThreadId: targetSessionId
    }));
    return {
      delivered: false,
      attempts: 1,
      error: `目标线程不存在: ${targetSessionId}`
    };
  }
  const announceEvent = buildAnnounceEvent(run, targetSessionId);
  let lastError = "";
  for (let attempt = 1; attempt <= ANNOUNCE_MAX_RETRIES; attempt += 1) {
    try {
      updateAgentThreadMeta(targetSessionId, {});
      log.info("announce delivered", subagentLogFields(run, {
        event: "announce_delivered",
        deliveryThreadId: targetSessionId,
        announceAttempts: attempt
      }));
      for (const listener of listeners) {
        try {
          listener(announceEvent);
        } catch {
          // ignore listener failures to keep announce delivery stable
        }
      }
      releaseSubagentThreadBinding({
        runId: run.runId,
        childThreadId: run.childThreadId,
        deliveryThreadId: targetSessionId,
        threadBound: run.threadBound
      });
      return {
        delivered: true,
        attempts: attempt,
        event: announceEvent
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      log.warn("announce attempt failed", subagentLogFields(run, {
        event: "announce_retry",
        deliveryThreadId: targetSessionId,
        announceAttempts: attempt,
        error: lastError
      }));
      if (attempt < ANNOUNCE_MAX_RETRIES) {
        await waitRetry(attempt);
      }
    }
  }
  log.error("announce failed", subagentLogFields(run, {
    event: "announce_failed",
    deliveryThreadId: targetSessionId,
    error: lastError || "unknown error"
  }));
  return {
    delivered: false,
    attempts: ANNOUNCE_MAX_RETRIES,
    error: lastError || "unknown error"
  };
}

export function subscribeSubagentAnnounceEvent(
  listener: (event: AgentSubagentCompletionEvent) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
