import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type {
  AutomationJob,
  AutomationListRunsInput,
  AutomationRun,
  AutomationRunNowInput,
  Channel
} from "@lume/shared";
import { createAgentSession } from "./agent-session-manager";
import { sendAgentMessage } from "./agent-service";
import { listAutomationJobs, updateAutomationJob } from "./automation-manager";
import { listChannels } from "./channel-manager";
import { getAutomationRunsPath } from "./config-paths";

type JobDisposer = () => void;

const jobDisposers = new Map<string, JobDisposer>();
const runningJobs = new Set<string>();
const lastCronMinuteKeyByJob = new Map<string, string>();
let runnerStarted = false;

function minuteKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}T${hh}:${mm}`;
}

function parseCronField(token: string, min: number, value: number): boolean {
  const raw = token.trim();
  if (!raw) return false;
  if (raw === "*") return true;
  if (raw.startsWith("*/")) {
    const step = Number.parseInt(raw.slice(2), 10);
    if (!Number.isFinite(step) || step <= 0) return false;
    return (value - min) % step === 0;
  }
  const segments = raw.split(",");
  for (const segment of segments) {
    const part = segment.trim();
    if (!part) continue;
    if (part.includes("-")) {
      const [startRaw, endRaw] = part.split("-", 2);
      const start = Number.parseInt(startRaw ?? "", 10);
      const end = Number.parseInt(endRaw ?? "", 10);
      if (Number.isFinite(start) && Number.isFinite(end) && value >= start && value <= end) {
        return true;
      }
      continue;
    }
    const exact = Number.parseInt(part, 10);
    if (Number.isFinite(exact) && value === exact) {
      return true;
    }
  }
  return false;
}

function matchCronExpr(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minExpr, hourExpr, dayExpr, monthExpr, weekExpr] = parts;
  return (
    parseCronField(minExpr ?? "", 0, date.getMinutes())
    && parseCronField(hourExpr ?? "", 0, date.getHours())
    && parseCronField(dayExpr ?? "", 1, date.getDate())
    && parseCronField(monthExpr ?? "", 1, date.getMonth() + 1)
    && parseCronField(weekExpr ?? "", 0, date.getDay())
  );
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

function pickExecutionChannel(): { channelId: string; modelId: string } {
  const channels = listChannels().filter((channel) => channel.enabled);
  if (channels.length === 0) {
    throw new Error("未找到可用渠道，请先在设置中配置并启用 Agent 渠道");
  }

  const withModel = channels.find((channel) => pickModelId(channel) !== null);
  if (!withModel) {
    throw new Error("未找到可用模型，请先在渠道里启用至少一个模型");
  }

  const modelId = pickModelId(withModel);
  if (!modelId) {
    throw new Error("渠道缺少可用模型");
  }
  return { channelId: withModel.id, modelId };
}

function pickModelId(channel: Channel): string | null {
  const enabledModels = channel.models.filter((model) => model.enabled);
  if (enabledModels.length === 0) return null;
  if (channel.defaultModelId) {
    const hit = enabledModels.find((model) => model.id === channel.defaultModelId);
    if (hit) return hit.id;
  }
  return enabledModels[0]?.id ?? null;
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
  let sessionId: string | undefined;
  let runStatus: AutomationRun["status"] = "success";
  let runMessage = "任务执行完成";

  try {
    const { channelId, modelId } = pickExecutionChannel();
    const session = createAgentSession(`[自动化] ${job.name}`, channelId, job.workspaceId);
    sessionId = session.id;

    let runtimeError: string | null = null;
    await sendAgentMessage(
      {
        sessionId: session.id,
        userMessage: job.prompt,
        workspaceId: job.workspaceId,
        channelId,
        modelId
      },
      {
        onEvent: () => {},
        onComplete: () => {},
        onError: (error) => {
          runtimeError = error;
        },
        onTitleUpdated: () => {},
        onAskUserQuestion: () => {
          runtimeError = "任务执行需要用户交互，自动化模式当前不支持";
        },
        onToolPermissionRequest: () => {
          runtimeError = "任务执行需要工具权限确认，自动化模式当前不支持";
        }
      },
      { appendUserMessage: true }
    );

    if (runtimeError) {
      throw new Error(runtimeError);
    }

    runMessage = `任务执行完成，会话: ${session.id}`;
  } catch (error) {
    runStatus = "failed";
    runMessage = error instanceof Error ? error.message : String(error);
  } finally {
    runningJobs.delete(job.id);
    if (job.schedule.type === "once") {
      try {
        updateAutomationJob({ id: job.id, enabled: false });
      } catch {
        // ignore disable failure
      }
    }
  }

  const run: AutomationRun = {
    id: randomUUID(),
    jobId: job.id,
    jobName: job.name,
    ...(sessionId ? { sessionId } : {}),
    trigger,
    status: runStatus,
    message: runMessage,
    startedAt,
    finishedAt: Date.now()
  };
  appendRun(run);
  return run;
}

function scheduleJob(job: AutomationJob): void {
  if (!job.enabled) return;
  if (job.schedule.type === "once") {
    const delay = Math.max(0, (job.schedule.runAt ?? 0) - Date.now());
    const timer = setTimeout(() => {
      const latest = listAutomationJobs().find((item) => item.id === job.id);
      if (!latest || !latest.enabled) return;
      void executeJob(latest, "schedule").finally(() => {
        void refreshAutomationRunnerJobs();
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
      if (!matchCronExpr(expr, now)) return;
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
