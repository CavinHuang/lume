import {
  loadProcessJobs,
  markProcessJobNotified,
  waitForProcessJobTerminal,
  type ProcessJob,
} from "@lume/agent-sdk";
import type { SDKMessage } from "@lume/shared";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentFileContextsDir } from "../infra/config-paths";
import { createLogger } from "../infra/logger";
import {
  appendAgentThreadSDKMessages,
  getAgentThreadMeta,
  getAgentThreadSDKMessages,
} from "./agent-thread-manager";

const log = createLogger("background-process-recovery");

export function startBackgroundProcessRecovery(): () => void {
  const abortController = new AbortController();

  const watch = async (job: ProcessJob): Promise<void> => {
    try {
      let current: ProcessJob | undefined = job;
      while (!abortController.signal.aborted && current?.status === "running") {
        current = await waitForProcessJobTerminal(current.id, 60_000, abortController.signal);
      }
      if (!abortController.signal.aborted && current) persistTerminalProcessJobNotification(current);
    } catch (error) {
      if (!abortController.signal.aborted) {
        log.warn("failed to restore background task notification", {
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };

  for (const job of scanPersistedProcessJobs()) void watch(job);
  return () => abortController.abort();
}

function scanPersistedProcessJobs(): ProcessJob[] {
  const contextsRoot = getAgentFileContextsDir();
  if (!existsSync(contextsRoot)) return [];
  const jobs = new Map<string, ProcessJob>();
  for (const entry of readdirSync(contextsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = join(contextsRoot, entry.name, "artifacts", "process-jobs");
    for (const job of loadProcessJobs(root)) jobs.set(job.id, job);
  }
  return [...jobs.values()];
}

export function persistTerminalProcessJobNotification(job: ProcessJob): void {
  if (!job.threadId || job.status === "running" || job.continuationConsumedAt) return;
  const thread = getAgentThreadMeta(job.threadId);
  if (!thread || thread.status === "trashed") return;

  const notification = toTaskNotification(job);
  const alreadyPersisted = getAgentThreadSDKMessages(job.threadId).some((message) => (
    message.type === "system"
    && message.subtype === "task_notification"
    && message.task_id === job.id
  ));
  if (!alreadyPersisted) appendAgentThreadSDKMessages(job.threadId, [notification]);
  markProcessJobNotified(job.id);
}

function toTaskNotification(job: ProcessJob): SDKMessage {
  const execution = job.metadata?.execution;
  return {
    type: "system",
    subtype: "task_notification",
    task_id: job.id,
    ...(job.toolUseId ? { tool_use_id: job.toolUseId } : {}),
    status: job.status,
    output_file: job.outputFile,
    summary: `Background process ${job.status}. Full output: ${job.outputFile ?? "(unavailable)"}`,
    message: job.output ?? "(no output)",
    ...(execution && typeof execution === "object" ? { execution } : {}),
    session_id: job.threadId ?? "",
  } as SDKMessage;
}
