import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type {
  AutomationJob,
  AutomationListRunsInput,
  AutomationRun,
  AutomationRunNowInput
} from "@lume/shared";
import { createAgentThreadWithModelRef, getAgentThreadMeta, updateAgentThreadMeta } from "../agent/agent-thread-manager";
import { sendAgentMessage } from "../agent/agent-service";
import { listAutomationJobs, recordAutomationJobRun, updateAutomationJob } from "./automation-manager";
import { resolveChannelModelBinding } from "../channel/channel-manager";
import { getAutomationRunsPath } from "../infra/config-paths";
import { getEffectiveSystemConfig } from "../system/system-config-service";
import { getEffectiveLumeConfig } from "../system/lume-config-service";
import { matchCronExpression } from "./automation-schedule";

type JobDisposer = () => void;

const jobDisposers = new Map<string, JobDisposer>();
const runningJobs = new Set<string>();
const lastCronMinuteKeyByJob = new Map<string, string>();
let runnerStarted = false;

type NotificationWriter = (method: string, params: unknown) => void;
let notificationWriter: NotificationWriter | null = null;

export function setAutomationNotificationWriter(writer: NotificationWriter): void {
  notificationWriter = writer;
}

function minuteKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}T${hh}:${mm}`;
}

function appendRun(run: AutomationRun): void {
  appendFileSync(getAutomationRunsPath(), `${JSON.stringify(run)}\n`, "utf-8");
}

function clearSchedules(): void {
  for (const dispose of jobDisposers.values()) {
    try {
      dispose();
    } catch {
      // ignore dispose error
    }
  }
  jobDisposers.clear();
  lastCronMinuteKeyByJob.clear();
}

/**
 * 判定自动化任务使用哪类模型配置：
 * - routine：日程任务（systemAction='routine'）
 * - automation：用户手动或让 agent 创建的定时任务（source !== 'system'）
 * - agent：其他系统任务（如记忆蒸馏），用默认对话模型
 */
export function resolveAutomationModelKind(job: { systemAction?: string; source?: string }): "routine" | "automation" | "agent" {
  if (job.systemAction === "routine") return "routine";
  if (job.source !== "system") return "automation";
  return "agent";
}

function pickExecutionChannel(job: AutomationJob): { channelId: string; modelId: string; modelRef: string } {
  const kind = resolveAutomationModelKind(job);
  let modelRef: string | undefined;
  if (kind === "agent") {
    modelRef = getEffectiveSystemConfig().models?.agent?.defaultModelRef;
  } else {
    const config = getEffectiveLumeConfig();
    const specific = kind === "routine"
      ? config.models?.routine?.defaultModelRef
      : config.models?.automation?.defaultModelRef;
    modelRef = specific || config.models?.agent?.defaultModelRef;
  }
  const binding = resolveChannelModelBinding(modelRef ?? "", "chat");
  if (!binding || !modelRef) {
    throw new Error("未找到可用的 Agent 默认模型，请先在通用设置中配置");
  }
  return {
    channelId: binding.channel.id,
    modelId: binding.modelId,
    modelRef
  };
}

async function executeJob(job: AutomationJob, trigger: "schedule" | "manual"): Promise<AutomationRun> {
  const startedAt = Date.now();
  if (runningJobs.has(job.id)) {
    const skipped: AutomationRun = {
      id: randomUUID(),
      jobId: job.id,
      jobName: job.name,
      trigger,
      status: "skipped",
      message: "任务仍在运行，已跳过本次触发",
      startedAt,
      finishedAt: Date.now()
    };
    appendRun(skipped);
    return skipped;
  }

  runningJobs.add(job.id);
  let threadId: string | undefined;
  let runStatus: AutomationRun["status"] = "success";
  let runMessage = "任务执行完成";

  try {
    const { channelId, modelId, modelRef } = pickExecutionChannel(job);
    const boundThreadId = job.threadId?.trim();
    if (boundThreadId && getAgentThreadMeta(boundThreadId)) {
      threadId = boundThreadId;
    } else {
      const thread = createAgentThreadWithModelRef(
        `[自动化] ${job.name}`,
        modelRef,
        channelId,
        job.workspaceId,
        undefined,
        modelId
      );
      threadId = thread.id;
    }
    if (!threadId) {
      throw new Error("自动化执行缺少可用线程");
    }

    let runtimeError: string | null = null;
    let waitingForApproval = false;
    await sendAgentMessage(
      {
        threadId,
        userMessage: job.prompt,
        workspaceId: job.workspaceId,
        modelRef,
        channelId,
        modelId,
        permissionMode: "bypassPermissions",
        messageMetadata: {
          automationJobId: job.id,
          automationTrigger: trigger
        }
      },
      {
        onComplete: () => {},
        onError: (error) => {
          runtimeError = error;
        },
        onTitleUpdated: () => {},
        onAskUserQuestion: () => {
          runtimeError = "任务执行需要用户交互，自动化模式当前不支持";
        },
        onToolPermissionRequest: () => {
          waitingForApproval = true;
        }
      },
      { appendUserMessage: false }
    );

    if (runtimeError) {
      throw new Error(runtimeError);
    }

    if (waitingForApproval) {
      runStatus = "waiting_for_approval";
      runMessage = `任务暂停：等待工具权限确认，线程: ${threadId}`;
    } else {
      runMessage = `任务执行完成，线程: ${threadId}`;
    }
  } catch (error) {
    runStatus = "failed";
    runMessage = error instanceof Error ? error.message : String(error);
  } finally {
    runningJobs.delete(job.id);
    // Archive the automation thread so it does not appear in the sidebar
    if (threadId) {
      try { updateAgentThreadMeta(threadId, { status: "archived" }); } catch { /* ignore */ }
    }
  }

  let latestJob = job;
  try {
    latestJob = recordAutomationJobRun({ id: job.id, startedAt });
  } catch {
    // ignore status write failure
  }
  if (job.schedule.type === "once") {
    try {
      latestJob = updateAutomationJob({ id: job.id, enabled: false });
    } catch {
      // ignore disable failure
    }
  }

  const run: AutomationRun = {
    id: randomUUID(),
    jobId: job.id,
    jobName: job.name,
    ...(threadId ? { threadId } : {}),
    trigger,
    status: runStatus,
    message: runMessage,
    startedAt,
    finishedAt: Date.now()
  };
  appendRun(run);
  if (notificationWriter) {
    notificationWriter("automation:run-completed", {
      run,
      jobName: job.name,
      jobEnabled: latestJob.enabled
    });
  }
  return run;
}

function scheduleJob(job: AutomationJob): void {
  if (!job.enabled) return;
  if (job.schedule.type === "once") {
    const delay = Math.max(0, (job.schedule.runAt ?? 0) - Date.now());
    const timer = setTimeout(() => {
      const latest = listAutomationJobs().find((item) => item.id === job.id);
      if (!latest || !latest.enabled) return;
      // 跳过的触发（任务仍在运行）不得重排调度：过期 once 任务 delay=0，
      // 若 skip 后 refresh 会重新 setTimeout(0) → 再次 skip → refresh，
      // 形成以事件循环速率自转的死循环（线上实测 ~360 次/秒、单任务数万条 skip）。
      void executeJob(latest, "schedule").then((run) => {
        if (run.status !== "skipped") {
          void refreshAutomationRunnerJobs();
        }
      });
    }, delay);
    jobDisposers.set(job.id, () => clearTimeout(timer));
    return;
  }

  if (job.schedule.type === "interval") {
    const intervalMs = Math.max(1_000, job.schedule.intervalMs ?? 1_000);
    const timer = setInterval(() => {
      const latest = listAutomationJobs().find((item) => item.id === job.id);
      if (!latest || !latest.enabled) return;
      void executeJob(latest, "schedule");
    }, intervalMs);
    jobDisposers.set(job.id, () => clearInterval(timer));
    return;
  }

  if (job.schedule.type === "cron") {
    const expr = job.schedule.cronExpr?.trim();
    if (!expr) return;
    const timer = setInterval(() => {
      const latest = listAutomationJobs().find((item) => item.id === job.id);
      if (!latest || !latest.enabled) return;
      const now = new Date();
      const key = minuteKey(now);
      if (lastCronMinuteKeyByJob.get(job.id) === key) return;
      if (!matchCronExpression(expr, now)) return;
      lastCronMinuteKeyByJob.set(job.id, key);
      void executeJob(latest, "schedule");
    }, 15_000);
    jobDisposers.set(job.id, () => clearInterval(timer));
  }
}

export async function refreshAutomationRunnerJobs(): Promise<void> {
  if (!runnerStarted) return;
  clearSchedules();
  const jobs = listAutomationJobs();
  for (const job of jobs) {
    scheduleJob(job);
  }
}

export async function startAutomationRunner(): Promise<void> {
  if (runnerStarted) return;
  runnerStarted = true;
  await refreshAutomationRunnerJobs();
}

export async function stopAutomationRunner(): Promise<void> {
  runnerStarted = false;
  clearSchedules();
}

export async function runAutomationJobNow(input: AutomationRunNowInput): Promise<AutomationRun> {
  const job = listAutomationJobs().find((item) => item.id === input.id);
  if (!job) {
    throw new Error(`自动化任务不存在: ${input.id}`);
  }
  if (!job.enabled) {
    throw new Error("任务已禁用，无法执行");
  }
  return executeJob(job, "manual");
}

function parseRunLine(line: string): AutomationRun | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as AutomationRun;
    if (!parsed?.id || !parsed?.jobId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function listAutomationRuns(input: AutomationListRunsInput = {}): AutomationRun[] {
  const path = getAutomationRunsPath();
  if (!existsSync(path)) return [];
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const lines = readFileSync(path, "utf-8").split("\n");
  const runs: AutomationRun[] = [];
  for (const line of lines) {
    const run = parseRunLine(line);
    if (!run) continue;
    if (input.jobId && run.jobId !== input.jobId) continue;
    runs.push(run);
  }
  return runs.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
}
