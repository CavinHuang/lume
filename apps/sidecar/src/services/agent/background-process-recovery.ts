import {
  loadProcessJobs,
  markProcessJobNotified,
  stopPersistedWorker,
  updateProcessJob,
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
  findAgentThreadSDKMessage,
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

/**
 * Coding Run 撤销（REVERT_CODING_RUN）的对齐守卫:被撤销 Run 启动的仍在运行的
 * 后台任务一并停止,并预先消费其通知权——它们的完成事件针对的是已回滚的文件
 * 状态,继续投递会诱导模型基于过期结果行动。其他 Run / 手动起的后台任务不受影响。
 * 对齐 ZCode cancelRemovedBranchBackgroundTasks 的"撤销时间线丢弃在途任务"语义。
 */
export function stopRunningProcessJobsForCodingRun(
  threadId: string,
  runId: string,
  reason: string,
  jobsRootOverride?: string,
): ProcessJob[] {
  const root = jobsRootOverride ?? join(getAgentFileContextsDir(), threadId, "artifacts", "process-jobs");
  if (!existsSync(root)) return [];
  const stopped: ProcessJob[] = [];
  for (const job of loadProcessJobs(root)) {
    if (job.status !== "running") continue;
    if (!job.runId || job.runId !== runId) continue;
    try {
      const stoppedOk = stopPersistedWorker(job);
      updateProcessJob(job.id, {
        status: "stopped",
        // 预先消费通知权:completeBackgroundTask 与 ProcessOutput 都以
        // markProcessJobNotified 为闸,置位后不再产生 task_notification
        notified: true,
        notificationDeliveredAt: Date.now(),
        metadata: {
          ...job.metadata,
          execution: {
            ...(job.metadata?.execution as Record<string, unknown> | undefined),
            version: 2,
            outcome: "cancelled",
            terminationReason: "aborted",
            durationMs: Math.max(0, Date.now() - (job.startedAt ?? Date.now())),
          },
        },
      });
      stopped.push(job);
      log.warn("stopped background job of reverted coding run", {
        threadId,
        runId,
        reason,
        jobId: job.id,
        workerKilled: stoppedOk,
      });
    } catch (error) {
      log.warn("failed to stop background job of reverted coding run", {
        threadId,
        runId,
        jobId: job.id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return stopped;
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
  // #554 复核清单:终态通知恒尾部追加,尾窗谓词查找免全量解析(窗外回退语义等价)
  const alreadyPersisted = findAgentThreadSDKMessage(job.threadId, (message) => (
    message.type === "system"
    && message.subtype === "task_notification"
    && message.task_id === job.id
  )) !== undefined;
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
