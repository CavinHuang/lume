import {
  loadProcessJobs,
  markProcessJobContinuationConsumed,
  markProcessJobNotified,
  updateProcessJob,
  waitForProcessJobTerminal,
  type ProcessJob,
} from "@lume/agent-sdk";
import { AGENT_IPC_CHANNELS, type SDKMessage } from "@lume/shared";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentFileContextsDir } from "../infra/config-paths";
import { createLogger } from "../infra/logger";
import {
  appendAgentThreadSDKMessages,
  getAgentThreadMeta,
  getAgentThreadSDKMessages,
} from "./agent-thread-manager";
import { BACKGROUND_TASK_WAKE_PROMPT } from "./agent-background-wake";

const log = createLogger("background-process-recovery");

export function startBackgroundProcessRecovery(
  writeNotification: (method: string, params: unknown) => void,
): () => void {
  let stopped = false;
  const jobs = scanPersistedProcessJobs();

  const watch = async (job: ProcessJob): Promise<void> => {
    let current: ProcessJob | undefined = job;
    while (!stopped && current?.status === "running") {
      current = await waitForProcessJobTerminal(current.id, 60_000);
    }
    if (!stopped && current) await resumeTerminalProcessJob(current, writeNotification);
  };

  for (const job of jobs) void watch(job);
  return () => { stopped = true; };
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

async function resumeTerminalProcessJob(
  job: ProcessJob,
  writeNotification: (method: string, params: unknown) => void,
): Promise<void> {
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
  if (job.taskType === "shell") return;
  if (!markProcessJobContinuationConsumed(job.id)) return;

  try {
    const { sendAgentMessage } = await import("./agent-service");
    await sendAgentMessage({
      threadId: job.threadId,
      userMessage: BACKGROUND_TASK_WAKE_PROMPT,
      ...(thread.workspaceId ? { workspaceId: thread.workspaceId } : {}),
      ...(thread.modelRef ? { modelRef: thread.modelRef } : {}),
      ...(thread.channelId ? { channelId: thread.channelId } : {}),
      ...(thread.modelId ? { modelId: thread.modelId } : {}),
      messageMetadata: {
        hiddenFromChat: true,
        backgroundRecovery: {
          processJobId: job.id,
          runId: job.runId,
          toolUseId: job.toolUseId,
        },
      },
      traceContext: {
        submissionId: `background-recovery:${job.id}`,
        traceId: `background-recovery:${job.id}`,
        origin: "resume",
      },
    }, {
      onRuntimeEvent: (event) => writeNotification(AGENT_IPC_CHANNELS.RUNTIME_EVENT, {
        threadId: job.threadId,
        event,
      }),
      onMessageAppended: (event) => writeNotification(AGENT_IPC_CHANNELS.MESSAGE_APPENDED, event),
      onComplete: () => undefined,
      onError: (error) => log.error("background continuation failed", { jobId: job.id, error }),
      onTitleUpdated: (title) => writeNotification(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
        threadId: job.threadId,
        title,
      }),
      onAskUserQuestion: (request) => writeNotification(AGENT_IPC_CHANNELS.ASK_USER_QUESTION, request),
      onBrowserAuthRequest: (request) => writeNotification(AGENT_IPC_CHANNELS.BROWSER_AUTH_REQUEST, request),
      onDesktopActionRequest: (request) => writeNotification(AGENT_IPC_CHANNELS.DESKTOP_ACTION_REQUEST, request),
      onToolPermissionRequest: (request) => writeNotification(AGENT_IPC_CHANNELS.TOOL_PERMISSION_REQUEST, request),
    }, { appendUserMessage: false });
  } catch (error) {
    updateProcessJob(job.id, { continuationConsumedAt: undefined });
    log.error("failed to resume persisted background process", {
      jobId: job.id,
      threadId: job.threadId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
