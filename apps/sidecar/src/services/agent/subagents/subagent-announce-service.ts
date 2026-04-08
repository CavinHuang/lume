import { randomUUID } from "node:crypto";
import type { AgentMessage, SDKMessage } from "@lume/shared";
import {
  appendAgentTranscriptMessage,
  getAgentSessionMeta,
  updateAgentSessionMeta
} from "../../agent/agent-session-manager";
import { createLogger } from "../../infra/logger";
import { subagentLogFields } from "./subagent-run-registry";
import type { SubagentRun } from "./subagent-run.types";
import { releaseSubagentThreadBinding } from "./subagent-thread-binding";

// ─── Announce service ───

const ANNOUNCE_MAX_RETRIES = 3;
const ANNOUNCE_RETRY_DELAYS_MS = [40, 120, 320] as const;
const log = createLogger("subagent-announce");
const listeners = new Set<(event: { threadId: string; message: AgentMessage }) => void>();

export interface SubagentAnnounceResult {
  delivered: boolean;
  attempts: number;
  message?: AgentMessage;
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

function buildAnnounceMessage(run: SubagentRun): AgentMessage {
  const output = typeof run.outcome?.output === "string" ? run.outcome.output.trim() : "";
  const error = typeof run.outcome?.error === "string" ? run.outcome.error.trim() : "";
  const status = formatStatusLabel(run.status);
  const label = run.label?.trim() || "子任务";
  const headline = `子任务完成通知: ${label} (${status})`;
  const bodyLines = [
    headline,
    `runId: ${run.runId}`,
    `childSessionKey: ${run.childThreadId}`
  ];
  if (output) {
    bodyLines.push("", "输出摘要:", truncateText(output, 1200));
  }
  if (error) {
    bodyLines.push("", `错误: ${truncateText(error, 600)}`);
  }
  const messageText = bodyLines.join("\n");
  const toolUseId = `subagent-announce:${run.runId}`;
  const sdkMessages: SDKMessage[] = [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: toolUseId,
          name: "Agent",
          input: {
            name: label,
            description: run.task,
            subagent_type: "completion_announce",
            run_id: run.runId,
            child_session_key: run.childThreadId
          }
        }]
      }
    } as SDKMessage,
    {
      type: "user",
      parent_tool_use_id: toolUseId,
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: toolUseId,
          content: JSON.stringify({
            runId: run.runId,
            status,
            childSessionKey: run.childThreadId,
            output: output ? truncateText(output, 1200) : undefined,
            error: error || undefined
          }, null, 2),
          is_error: run.status !== "completed"
        }]
      }
    } as SDKMessage
  ];
  return {
    id: randomUUID(),
    role: "assistant",
    content: messageText,
    model: "subagent/announce",
    createdAt: Date.now(),
    metadata: {
      subagentAnnounce: true,
      runId: run.runId,
      childThreadId: run.childThreadId,
      status
    },
    sdkMessages
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
  const targetMeta = getAgentSessionMeta(targetSessionId);
  if (!targetMeta) {
    log.warn("announce skipped: target session not found", subagentLogFields(run, {
      event: "announce_skipped",
      deliveryThreadId: targetSessionId
    }));
    return {
      delivered: false,
      attempts: 1,
      error: `目标会话不存在: ${targetSessionId}`
    };
  }
  const announceMessage = buildAnnounceMessage(run);
  let lastError = "";
  for (let attempt = 1; attempt <= ANNOUNCE_MAX_RETRIES; attempt += 1) {
    try {
      appendAgentTranscriptMessage(targetSessionId, announceMessage);
      updateAgentSessionMeta(targetSessionId, {});
      log.info("announce delivered", subagentLogFields(run, {
        event: "announce_delivered",
        deliveryThreadId: targetSessionId,
        announceAttempts: attempt
      }));
      const event = { threadId: targetSessionId, message: announceMessage };
      for (const listener of listeners) {
        try {
          listener(event);
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
        message: announceMessage
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
  listener: (event: { threadId: string; message: AgentMessage }) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

