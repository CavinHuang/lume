import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type {
  AutomationJob,
  AutomationListRunsInput,
  AutomationRun,
  AutomationRunNowInput
} from "@lume/shared";
import { createAgentThreadWithModelRef, getAgentThreadMeta, updateAgentThreadMeta } from "../agent/agent-thread-manager";
import { dispatchAgentRun } from "../agent/agent-service";
import { advanceAutomationJobSchedule, listAutomationJobs, recordAutomationJobRun, updateAutomationJob } from "./automation-manager";
import { resolveChannelModelBinding } from "../channel/channel-manager";
import { getAutomationRunsPath } from "../infra/config-paths";
import { getEffectiveSystemConfig } from "../system/system-config-service";
import { getEffectiveLumeConfig } from "../system/lume-config-service";
import { getNextAutomationRunAt } from "./automation-schedule";
import { writeLogRecord } from "../infra/logger";
import { issuePlanningScopeGrant, registerPlanningExecutionContext } from "../planning/planning-execution-context";
import { readRoutine } from "../routine/routine-store";
import {
  consumeLatestAutomationTrigger,
  finishAutomationLease,
  heartbeatAutomationLease,
  mergeLatestAutomationTrigger,
  readAutomationRuntimeState,
  recoverAutomationRuntimeStates,
  tryAcquireAutomationLease
} from "./automation-runtime-store";

type JobDisposer = () => void;

const jobDisposers = new Map<string, JobDisposer>();
const runningJobs = new Set<string>();
let runnerStarted = false;

type NotificationWriter = (method: string, params: unknown) => void;
let notificationWriter: NotificationWriter | null = null;

export function setAutomationNotificationWriter(writer: NotificationWriter): void {
  notificationWriter = writer;
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

async function executeJob(job: AutomationJob, trigger: "schedule" | "manual", scheduledAt = Date.now()): Promise<AutomationRun> {
  const startedAt = Date.now();
  const runId = randomUUID();
  const lease = tryAcquireAutomationLease({ jobId: job.id, scheduledAt, runId });
  if (!lease || runningJobs.has(job.id)) {
    mergeLatestAutomationTrigger(job.id, scheduledAt);
    const skipped: AutomationRun = {
      id: runId,
      jobId: job.id,
      jobName: job.name,
      trigger,
      status: "skipped",
      message: "任务仍在运行或等待交互，本次触发已合并为最新待执行触发",
      startedAt,
      finishedAt: Date.now()
    };
    appendRun(skipped);
    return skipped;
  }

  runningJobs.add(job.id);
  const heartbeat = setInterval(() => {
    heartbeatAutomationLease(lease, threadId);
  }, 5_000);
  heartbeat.unref?.();
  let threadId: string | undefined;
  const traceContext = {
    submissionId: randomUUID(),
    traceId: randomUUID(),
    origin: "automation" as const
  };
  let runStatus: AutomationRun["status"] = "success";
  let runMessage = "任务执行完成";

  try {
    const { channelId, modelId, modelRef } = pickExecutionChannel(job);
    const executionKind = resolveAutomationModelKind(job);
    const provenance = job.provenance;
    const privilegedRoutineTodoReview = executionKind === "routine" && provenance?.kind === "routine_todo_review";
    if (privilegedRoutineTodoReview) {
      const date = provenance.routineId.replace(/^routine-/u, "");
      const routine = readRoutine(date);
      const entry = routine?.entries.find((item) => item.id === provenance.activityId);
      if (!routine || !entry || entry.activity !== "todo_review") throw new Error("routine provenance is no longer valid");
    }
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
        modelId,
        { fileContextMode: "newRoot" }
      );
      threadId = thread.id;
    }
    if (!threadId) {
      throw new Error("自动化执行缺少可用线程");
    }

    const executionSurface = executionKind === "routine" ? "routine" : "automation";
    registerPlanningExecutionContext({
      surface: executionSurface,
      threadId,
      clientSubmissionId: traceContext.submissionId,
      ...(privilegedRoutineTodoReview ? { globalPlanningRead: true } : {}),
      ...(job.workspaceId ? { workspaceId: job.workspaceId } : {})
    });
    issuePlanningScopeGrant({
      clientSubmissionId: traceContext.submissionId,
      surface: executionSurface,
      scope: privilegedRoutineTodoReview ? "all" : job.workspaceId ? "current" : "unassigned",
      ...(job.workspaceId ? { workspaceId: job.workspaceId } : {}),
      allowedOperations: ["list", "get"],
      mode: "turn"
    });

    let runtimeError: string | null = null;
    let waitingForApproval = false;
    let waitingForUser = false;
    // 经 kernel 派发：与用户消息共用线程互斥与队列，绑定线程忙时排队
    // （background 让位用户）而非并发互踩（#398）。
    await dispatchAgentRun(
      {
        threadId,
        userMessage: job.prompt,
        workspaceId: job.workspaceId,
        trustedPlanningClientSubmissionId: traceContext.submissionId,
        modelRef,
        channelId,
        modelId,
        permissionMode: "bypassPermissions",
        traceContext,
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
          waitingForUser = true;
        },
        onBrowserAuthRequest: () => {
          waitingForUser = true;
        },
        onToolPermissionRequest: () => {
          waitingForApproval = true;
        }
      },
      { priority: "background", appendUserMessage: false }
    );

    if (runtimeError) {
      throw new Error(runtimeError);
    }

    if (waitingForUser) {
      runStatus = "waiting_for_user";
      runMessage = `任务暂停：需要用户处理交互或浏览器凭证，线程: ${threadId}`;
    } else if (waitingForApproval) {
      runStatus = "waiting_for_approval";
      runMessage = `任务暂停：等待工具权限确认，线程: ${threadId}`;
    } else {
      runMessage = `任务执行完成，线程: ${threadId}`;
    }
  } catch (error) {
    runStatus = "failed";
    runMessage = error instanceof Error ? error.message : String(error);
  } finally {
    clearInterval(heartbeat);
    runningJobs.delete(job.id);
    const waitingForInteraction = runStatus === "waiting_for_user" || runStatus === "waiting_for_approval";
    finishAutomationLease(lease, {
      status: runStatus,
      ...(threadId ? { threadId } : {}),
      message: runMessage,
      keepForInteraction: waitingForInteraction
    });
    // Keep interactive runs visible so the user can resolve their checkpoint.
    if (threadId && !waitingForInteraction) {
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
  writeLogRecord({
    level: run.status === "failed" ? "error" : "info",
    kind: "trace",
    context: "agent.delivery.automation",
    event: "automation.result_persisted",
    message: "automation run result persisted",
    status: run.status === "failed" ? "error" : run.status === "waiting_for_approval" ? "unknown" : "ok",
    traceId: traceContext.traceId,
    submissionId: traceContext.submissionId,
    threadId,
    origin: traceContext.origin,
    durationMs: run.finishedAt - run.startedAt,
    data: { automationJobId: job.id, runId: run.id, trigger, runStatus: run.status }
  });
  if (notificationWriter) {
    notificationWriter("automation:run-completed", {
      run,
      jobName: job.name,
      jobEnabled: latestJob.enabled
    });
  }
  if (run.status !== "waiting_for_user" && run.status !== "waiting_for_approval" && job.schedule.type !== "once") {
    const pendingScheduledAt = consumeLatestAutomationTrigger(job.id);
    if (pendingScheduledAt !== undefined) {
      const latest = listAutomationJobs().find((item) => item.id === job.id);
      if (latest?.enabled) void executeJob(latest, "schedule", pendingScheduledAt);
    }
  }
  return run;
}

function scheduleJob(job: AutomationJob): void {
  if (!job.enabled) return;
  const runtimeState = readAutomationRuntimeState(job.id);
  if (runningJobs.has(job.id)
    || runtimeState?.status === "running"
    || runtimeState?.status === "waiting_for_user"
    || runtimeState?.status === "waiting_for_approval") {
    return;
  }
  if (job.schedule.type === "manual") return;
  const now = Date.now();
  const scheduledAt = job.nextRunAt ?? getNextAutomationRunAt(
    job.schedule,
    job.lastRunAt ?? job.updatedAt,
    job.scheduleAnchorAt ?? job.createdAt
  );
  if (scheduledAt === null) return;
  if (scheduledAt <= now && job.schedule.misfirePolicy === "skip") {
    if (job.schedule.type === "once") {
      updateAutomationJob({ id: job.id, enabled: false, disabledReason: "错过计划时间，按 skip 策略跳过" });
    } else {
      advanceAutomationJobSchedule({ id: job.id, fromAt: now });
    }
    return;
  }
  const delay = Math.max(0, Math.min(scheduledAt - now, 2_147_000_000));
  const timer = setTimeout(() => {
    const latest = listAutomationJobs().find((item) => item.id === job.id);
    if (!latest?.enabled) return;
    if (scheduledAt - Date.now() > 2_147_000_000) {
      void refreshAutomationRunnerJobs();
      return;
    }
    void executeJob(latest, "schedule", scheduledAt).then((run) => {
      if (run.status !== "skipped") void refreshAutomationRunnerJobs();
    });
  }, delay);
  jobDisposers.set(job.id, () => clearTimeout(timer));
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
  recoverAutomationRuntimeStates();
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

export function resumeAutomationAfterInteraction(threadId: string): void {
  const state = recoverAutomationRuntimeStates().find((candidate) =>
    candidate.threadId === threadId
    && (candidate.status === "waiting_for_user" || candidate.status === "waiting_for_approval")
    && candidate.lease
  );
  if (!state?.lease) return;
  finishAutomationLease({
    jobId: state.jobId,
    leaseId: state.lease.id,
    runId: state.lease.runId,
    scheduledAt: state.lease.scheduledAt
  }, {
    status: "success",
    threadId,
    message: "用户交互已解决，自动化 Run 已恢复完成。"
  });
  const pendingScheduledAt = consumeLatestAutomationTrigger(state.jobId);
  const latest = listAutomationJobs().find((job) => job.id === state.jobId);
  if (pendingScheduledAt !== undefined && latest?.enabled && latest.schedule.type !== "once") {
    void executeJob(latest, "schedule", pendingScheduledAt);
  } else {
    void refreshAutomationRunnerJobs();
  }
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
