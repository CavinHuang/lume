import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type {
  AutomationJob,
  AutomationListRunsInput,
  AutomationRun,
  AutomationRunNowInput
} from "@lume/shared";
import { createAgentThreadWithModelRef, getAgentThreadMeta, updateAgentThreadMeta } from "../agent/agent-thread-manager";
import { dispatchAgentRun, onAgentInteractionResolved } from "../agent/agent-service";
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
  try {
    appendFileSync(getAutomationRunsPath(), `${JSON.stringify(run)}\n`, "utf-8");
  } catch (error) {
    // 盘满/EBUSY 时放弃本条记录而非抛出（#615）：executeJob 以 void 发射且上层
    // 无 catch，reject 会变 unhandledRejection 并吞掉后续调度刷新链。
    // 丢记录必须留痕，否则排查盘满事故时日志与事实相反（result_persisted 照发）
    writeLogRecord({
      level: "error",
      context: "agent.delivery.automation",
      event: "automation.run_persist_failed",
      message: "automation runs.jsonl persist failed; this run record is lost",
      data: { jobId: run.jobId, runId: run.id, error: error instanceof Error ? error.message : String(error) },
    });
  }
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

/**
 * run 收尾状态判定（纯函数，便于单测各分支）。#649 review P1-1:触顶检测挂
 * onComplete 的 reason——T7a 后 sidecar 生产不再构造 run.turn_limited 事件
 * （已迁事件总线 run.end{stopReason:'max_turns'}），onRuntimeEvent 检测在生产中
 * 永不为真。触顶即停的无人值守任务必须如实记 failed，否则 desktop 通知面
 * （只对 failed/waiting_* 弹）对半途而废的任务永不提醒。
 */
export function resolveAutomationRunOutcome(input: {
  runtimeError: string | null;
  waitingForUser: boolean;
  waitingForApproval: boolean;
  turnLimitedStopped: boolean;
  threadId: string;
}): { status: AutomationRun["status"]; message: string } {
  if (input.runtimeError) throw new Error(input.runtimeError);
  if (input.waitingForUser) {
    return { status: "waiting_for_user", message: `任务暂停：需要用户处理交互或浏览器凭证，线程: ${input.threadId}` };
  }
  if (input.waitingForApproval) {
    return { status: "waiting_for_approval", message: `任务暂停：等待工具权限确认，线程: ${input.threadId}` };
  }
  if (input.turnLimitedStopped) {
    return { status: "failed", message: `任务达到回合上限未完成，线程: ${input.threadId}` };
  }
  return { status: "success", message: `任务执行完成，线程: ${input.threadId}` };
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
  // job 绑定的是用户会话线程时，跑完不得归档——那是用户正在用的聊天（#402）
  let threadIsBound = false;
  const traceContext = {
    submissionId: randomUUID(),
    traceId: randomUUID(),
    origin: "automation" as const
  };
  let runStatus: AutomationRun["status"] = "success";
  let runMessage = "任务执行完成";
  // #566 端到端 review:automation 通道不自动续跑(callerBoundsTurns 门)，触顶即停。
  // 必须如实记为 failed——「任务执行完成」会掩盖半途而废的无人值守任务。
  let turnLimitedStopped = false;

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
      threadIsBound = true;
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
        // 无人值守 bypass 仅授予 sidecar 内部调用方直写的 system 任务（routine 等，
        // #394）；manual 与缺省 source 一律回落用户权限配置——缺省视为 manual 的
        // fail-closed 口径同时堵住 suggest 等未显式写 source 的内部创建面（#647 P2-23）。
        ...(job.source === "system" ? { permissionMode: "bypassPermissions" as const } : {}),
        traceContext,
        messageMetadata: {
          automationJobId: job.id,
          automationTrigger: trigger
        }
      },
      {
        // #649 review P1-1:触顶检测挂 onComplete 的 reason——T7a 后 sidecar 生产不再
        // 构造 run.turn_limited 事件(已迁事件总线 run.end{stopReason:'max_turns'}),
        // onRuntimeEvent 检测在生产中永不为真。
        // #649 round3:max_turns 与 repeat_guard 都属「保护机制停止的半途而废」,
        // 漏 repeat_guard 会让无人值守任务被重复执行保护停下时仍记「任务执行完成」
        // (im-message-router 同款口径:两个 reason 都归 turn_limited)
        onComplete: (payload) => {
          if (payload?.reason === "max_turns" || payload?.reason === "repeat_guard") turnLimitedStopped = true;
        },
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

    const outcome = resolveAutomationRunOutcome({ runtimeError, waitingForUser, waitingForApproval, turnLimitedStopped, threadId });
    runStatus = outcome.status;
    runMessage = outcome.message;
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
    // 绑定用户线程的 job 只借用会话，跑完不归档（#402）。
    if (threadId && !threadIsBound && !waitingForInteraction) {
      try { updateAgentThreadMeta(threadId, { status: "archived" }); } catch { /* ignore */ }
    }
  }

  let latestJob = job;
  try {
    latestJob = recordAutomationJobRun({ id: job.id, startedAt });
  } catch {
    // 写失败时 lastRunAt/nextRunAt 不推进，照常 refresh 会按 stale 计划立即补跑，
    // 无人值守任务将反复重跑直至写恢复（Windows rename EBUSY 高发）。宁可显式
    // 暂停并告知用户，也不静默循环执行带权限的 LLM 任务（#399）。
    try {
      latestJob = updateAutomationJob({
        id: job.id,
        enabled: false,
        disabledReason: "执行记录写入失败，已自动暂停以防重复执行；排查磁盘/权限后可重新启用",
      });
    } catch {
      // 索引彻底不可写时仅能放弃本周期；下次触发若写恢复则正常
    }
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
  try {
    scheduleJobInner(job);
  } catch (error) {
    // 单个坏 job（如旧版放行的永假 cron 存量数据）不得毒化整轮刷新：
    // refresh 先 clearSchedules 再遍历，此处抛错会清光其余定时器且每次刷新复现（#452）
    writeLogRecord({
      level: "error",
      context: "automation.runner",
      event: "automation.schedule_job_failed",
      message: `自动化任务调度失败，已跳过: ${job.name}`,
      status: "error",
      data: { automationJobId: job.id, error: error instanceof Error ? error.message : String(error) }
    });
  }
}

function scheduleJobInner(job: AutomationJob): void {
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

/** 测试专用：当前已挂定时器的 job id 快照（#452 回归钉死）。 */
export function scheduledJobIdsForTests(): string[] {
  return [...jobDisposers.keys()];
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
  // #587:桌面端/IM 解决交互后收尾 waiting_* 任务并恢复调度
  onAgentInteractionResolved(resumeAutomationAfterInteraction);
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
  // #587:只读查找,不得走 recoverAutomationRuntimeStates——waiting_* 的心跳在
  // 进入等待时就停了,超过 STALE_LEASE_MS 后破坏性恢复会把状态改写成 interrupted
  // 并清掉 lease,通知路径(以及既有 RPC 调用点)将永远找不到可收尾的对象。
  // 破坏性清理只属于 startAutomationRunner 的启动语义。
  const state = listAutomationJobs()
    .map((job) => readAutomationRuntimeState(job.id))
    .find((candidate) =>
      candidate?.threadId === threadId
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
