import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
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
import { getLostAutomationRuns, recordLostAutomationRun } from "./automation-lost-runs";
import { issuePlanningScopeGrant, registerPlanningExecutionContext } from "../planning/planning-execution-context";
import { readRoutine } from "../routine/routine-store";
import {
  STALE_LEASE_MS,
  consumeLatestAutomationTrigger,
  finishAutomationLease,
  heartbeatAutomationLease,
  isStaleRunningLease,
  mergeLatestAutomationTrigger,
  readAutomationRuntimeState,
  recoverAutomationRuntimeStates,
  tryAcquireAutomationLease
} from "./automation-runtime-store";
import { getOutboundNotificationWriter } from "../infra/outbound-notification";

type JobDisposer = () => void;

const jobDisposers = new Map<string, JobDisposer>();
const runningJobs = new Set<string>();
let runnerStarted = false;

function appendRun(run: AutomationRun): void {
  // runs.jsonl 写失败（盘满/Windows EBUSY）不得让 fire-and-forget 的 executeJob 变成
  // unhandledRejection 断掉后续调度链（#615）：降级记日志+影子记录，放弃本次 run 记录
  const runsPath = getAutomationRunsPath();
  try {
    appendFileSync(runsPath, `${JSON.stringify(run)}\n`, "utf-8");
    rotateAutomationRunsIfBloated(runsPath);
  } catch (error) {
    recordLostAutomationRun(run);
    writeLogRecord({
      level: "error",
      context: "automation.runner",
      event: "automation.run_append_failed",
      message: "自动化运行记录落盘失败，已跳过（不影响任务状态推进）",
      status: "error",
      data: { automationJobId: run.jobId, runId: run.id, error: error instanceof Error ? error.message : String(error) }
    });
  }
}

/** #615 测试钩子:appendRun 的吞错契约需直接验证(调用方全在 executeJob 内部)。 */
export const appendRunForTest = appendRun;

// #555:automation-runs.jsonl 只追加、无轮转,三处高频列表入口(自动化页/routine
// 执行/cron 工具)全量读盘解析的成本随文件永久恶化。软上限触发的尾部截断使文件
// 有界:平时零开销(stat 一次),超限才一次性原子重写保留最近窗口,频率随增长
// 趋近于零。
const RUNS_FILE_SOFT_CAP_BYTES = 8 * 1024 * 1024;
const RUNS_ROTATE_KEEP_LINES = 4000;

/** 导出仅供测试:截断是数据删除路径,行为需钉死。 */
export function rotateAutomationRunsIfBloatedForTest(runsPath: string): void {
  rotateAutomationRunsIfBloated(runsPath);
}

function rotateAutomationRunsIfBloated(runsPath: string): void {
  try {
    if (statSync(runsPath).size < RUNS_FILE_SOFT_CAP_BYTES) return;
    const lines = readFileSync(runsPath, "utf-8").split("\n").filter(Boolean);
    if (lines.length <= RUNS_ROTATE_KEEP_LINES) return;
    const kept = lines.slice(-RUNS_ROTATE_KEEP_LINES);
    const tmpPath = `${runsPath}.tmp`;
    writeFileSync(tmpPath, `${kept.join("\n")}\n`, "utf-8");
    renameSync(tmpPath, runsPath);
    writeLogRecord({
      level: "warn",
      context: "automation",
      message: "automation runs file rotated",
      data: {
        droppedLines: lines.length - kept.length,
        keptLines: kept.length
      }
    });
  } catch {
    // 截断失败不阻断追加主流程:下次写入会再次尝试
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
    try {
      mergeLatestAutomationTrigger(job.id, scheduledAt);
    } catch (error) {
      // 盘满等写失败不得让 fire-and-forget 的 executeJob reject 断掉调度链（#615 review round5）
      writeLogRecord({
        level: "error",
        context: "automation.runner",
        event: "automation.trigger_merge_failed",
        message: "合并待执行触发落盘失败",
        status: "error",
        data: { automationJobId: job.id, error: error instanceof Error ? error.message : String(error) }
      });
    }
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
    // 定时器回调抛错即 uncaughtException 直通五击止损（盘满场景 5s 内必现），必须就地兜底
    try {
      heartbeatAutomationLease(lease, threadId);
    } catch (error) {
      writeLogRecord({
        level: "error",
        context: "automation.runner",
        event: "automation.heartbeat_failed",
        message: "自动化任务心跳续期失败（lease 可能被 stale 自愈回收）",
        status: "error",
        data: { automationJobId: job.id, error: error instanceof Error ? error.message : String(error) }
      });
    }
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
  const notificationWriter = getOutboundNotificationWriter();
  if (notificationWriter) {
    notificationWriter("automation:run-completed", {
      run,
      jobName: job.name,
      jobEnabled: latestJob.enabled
    });
  }
  if (run.status !== "waiting_for_user" && run.status !== "waiting_for_approval" && job.schedule.type !== "once") {
    const pendingScheduledAt = consumeLatestAutomationTrigger(job.id);
    // runnerStarted 门控：stop 后的关停窗口孵化新 run 只会被 process.exit 中途杀死（round12 生命周期 review）
    if (pendingScheduledAt !== undefined && runnerStarted) {
      const latest = listAutomationJobs().find((item) => item.id === job.id);
      // 二轮 review P3:void 递归不在任何外层 catch 链上,尾部失败须就地日志化
      if (latest?.enabled) {
        void executeJob(latest, "schedule", pendingScheduledAt).catch((error: unknown) => {
          writeLogRecord({
            level: "error",
            context: "automation.runner",
            event: "automation.reschedule_background_failed",
            message: `合并触发补跑的后台收尾失败: ${error instanceof Error ? error.message : String(error)}`,
            status: "error",
            data: { automationJobId: latest.id }
          });
        });
      }
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
  // running 态若心跳已超阈（快速重启 <30s 后 fresh lease 不触发启动期 recover），
  // 放行调度使 tryAcquire 的 stale 自愈得以触达——否则任务静默停摆至下一次完整重启（round12 生命周期 review）
  const runningLeaseStale = runtimeState?.status === "running"
    && Boolean(runtimeState.lease && Date.now() - runtimeState.lease.heartbeatAt > STALE_LEASE_MS);
  if (runningJobs.has(job.id)
    || (runtimeState?.status === "running" && !runningLeaseStale)
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
    // 二轮 review P3:executeJob 尾部(appendRun/重调度链)不在内部 try 内,
    // schedule 入口与递归补跑同样需要日志化 catch,否则 unhandledRejection
    // 进进程止损计数(累计 5 次退出)。
    const logScheduleTailFailure = (error: unknown): void => {
      writeLogRecord({
        level: "error",
        context: "automation.runner",
        event: "automation.schedule_background_failed",
        message: `调度执行的后台收尾失败: ${error instanceof Error ? error.message : String(error)}`,
        status: "error",
        data: { automationJobId: latest.id }
      });
    };
    void executeJob(latest, "schedule", scheduledAt).then((run) => {
      if (run.status !== "skipped") void refreshAutomationRunnerJobs();
    }, logScheduleTailFailure);
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
  // review P2:连点防护——上一轮未结束时二次触发会写 skipped 记录并在首轮
  // 完成后隐含一次 schedule 补跑,对用户表现为假成功 toast,入口即拒绝。
  // 二轮 review P1:仅「新鲜」running 态才拒绝——崩溃+30s 内重启留下的
  // running 孤儿(心跳冻结)必须放行,executeJob 的 tryAcquire 会偷锁自愈;
  // 无脑读盘拒绝会把「重试即自愈」通道堵死,任务永久砖化。waiting_* 心跳
  // 停摆是设计内(#587),维持拒绝由交互解决路径收尾。
  const runtimeState = readAutomationRuntimeState(input.id);
  const runtimeRunningLive =
    runtimeState?.status === "running" && !isStaleRunningLease(runtimeState);
  if (runningJobs.has(input.id) || runtimeRunningLive
    || runtimeState?.status === "waiting_for_user" || runtimeState?.status === "waiting_for_approval") {
    throw new Error("任务正在执行中，请等待完成后再试");
  }
  // #586:受理即返回回执，不同步等待回合完成——真实任务普遍超 desktop 45s RPC
  // 超时，同步等待必然报 timed out 而任务实际在跑；完成经既有
  // automation:run-completed 推送（useAutomationListeners 收到后自动刷新）。
  // review P2:.catch 必须日志化——executeJob 尾部的 appendRun/通知/重调度链
  // 不在内部 try 内（Windows rename EBUSY 高发），零痕迹吞掉会让失败不可诊断。
  void executeJob(job, "manual").catch((error: unknown) => {
    writeLogRecord({
      level: "error",
      context: "automation.runner",
      event: "automation.run_now_background_failed",
      message: `立即执行的后台收尾失败: ${error instanceof Error ? error.message : String(error)}`,
      status: "error",
      data: { automationJobId: job.id }
    });
  });
  const now = Date.now();
  return {
    id: `run-now:${job.id}:${now}`,
    jobId: job.id,
    jobName: job.name,
    trigger: "manual",
    status: "running",
    message: "已受理，正在后台执行",
    startedAt: now,
    finishedAt: now
  };
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
  // runnerStarted 门控：关停窗口不得孵化新 run（round12 生命周期 review）
  if (pendingScheduledAt !== undefined && latest?.enabled && latest.schedule.type !== "once" && runnerStarted) {
    void executeJob(latest, "schedule", pendingScheduledAt).catch((error) => {
      writeLogRecord({
        level: "error",
        context: "automation.runner",
        event: "automation.execute_rejected",
        message: "自动化任务执行链异常终止",
        status: "error",
        data: { automationJobId: state.jobId, error: error instanceof Error ? error.message : String(error) }
      });
    });
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
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const runs: AutomationRun[] = [...getLostAutomationRuns()];
  const path = getAutomationRunsPath();
  if (existsSync(path)) {
    const lines = readFileSync(path, "utf-8").split("\n");
    for (const line of lines) {
      const run = parseRunLine(line);
      if (!run) continue;
      runs.push(run);
    }
  }
  const filtered = input.jobId ? runs.filter((run) => run.jobId === input.jobId) : runs;
  return filtered.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
}
