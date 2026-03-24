import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@lume/shared";
import {
  appendAgentTranscriptMessage,
  getAgentSessionMeta,
  updateAgentSessionMeta
} from "../../agent-session-manager";
import { createLogger } from "../../logger";
import { subagentLogFields } from "./subagent-observability";
import type { SubagentRun } from "./subagent-run.types";
import { emitSubagentAnnounceEvent } from "./subagent-announce-bus";
import { releaseSubagentThreadBinding } from "./subagent-thread-binding";

const ANNOUNCE_MAX_RETRIES = 3;
const ANNOUNCE_RETRY_DELAYS_MS = [40, 120, 320] as const;
const log = createLogger("subagent-announce");

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
    `childSessionKey: ${run.childSessionId}`
  ];
  if (output) {
    bodyLines.push("", "输出摘要:", truncateText(output, 1200));
  }
  if (error) {
    bodyLines.push("", `错误: ${truncateText(error, 600)}`);
  }
  const messageText = bodyLines.join("\n");
  const toolUseId = `subagent-announce:${run.runId}`;
  return {
    id: randomUUID(),
    role: "assistant",
    content: messageText,
    model: "subagent/announce",
    createdAt: Date.now(),
    metadata: {
      subagentAnnounce: true,
      runId: run.runId,
      childSessionId: run.childSessionId,
      status
    },
    events: [
      {
        type: "tool_start",
        toolName: "Agent",
        toolUseId,
        input: {
          name: label,
          description: run.task,
          subagent_type: "completion_announce",
          run_id: run.runId,
          child_session_key: run.childSessionId
        }
      },
      {
        type: "tool_result",
        toolUseId,
        toolName: "Agent",
        result: JSON.stringify({
          runId: run.runId,
          status,
          childSessionKey: run.childSessionId,
          output: output ? truncateText(output, 1200) : undefined,
          error: error || undefined
        }, null, 2),
        isError: run.status !== "completed"
      }
    ]
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
  const targetSessionId = run.deliverySessionId ?? run.parentSessionId;
  const targetMeta = getAgentSessionMeta(targetSessionId);
  if (!targetMeta) {
    log.warn("announce skipped: target session not found", subagentLogFields(run, {
      event: "announce_skipped",
      deliverySessionId: targetSessionId
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
      emitSubagentAnnounceEvent({
        sessionId: targetSessionId,
        runId: run.runId,
        childSessionId: run.childSessionId,
        status: run.status,
        message: announceMessage
      });
      log.info("announce delivered", subagentLogFields(run, {
        event: "announce_delivered",
        deliverySessionId: targetSessionId,
        announceAttempts: attempt
      }));
      releaseSubagentThreadBinding({
        runId: run.runId,
        childSessionId: run.childSessionId,
        deliverySessionId: targetSessionId,
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
        deliverySessionId: targetSessionId,
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
    deliverySessionId: targetSessionId,
    error: lastError || "unknown error"
  }));
  return {
    delivered: false,
    attempts: ANNOUNCE_MAX_RETRIES,
    error: lastError || "unknown error"
  };
}
