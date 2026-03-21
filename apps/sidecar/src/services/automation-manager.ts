import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type {
  AutomationCreateJobInput,
  AutomationDeleteJobInput,
  AutomationJob,
  AutomationJobsIndex,
  AutomationSchedule,
  AutomationUpdateJobInput
} from "@lume/shared";
import { getAutomationJobsPath } from "./config-paths";

const INDEX_VERSION = 1;

function writeJsonAtomic(path: string, payload: string): void {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

function backupCorruptIndex(indexPath: string): void {
  if (!existsSync(indexPath)) return;
  const backupPath = `${indexPath}.corrupt-${Date.now()}`;
  try {
    renameSync(indexPath, backupPath);
    console.warn(`[自动化任务] 检测到损坏索引，已备份: ${backupPath}`);
  } catch (error) {
    console.warn("[自动化任务] 备份损坏索引失败:", error);
  }
}

function readIndex(): AutomationJobsIndex {
  const indexPath = getAutomationJobsPath();
  if (!existsSync(indexPath)) {
    return { version: INDEX_VERSION, jobs: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf-8")) as AutomationJobsIndex;
    if (!Array.isArray(parsed.jobs)) {
      throw new Error("jobs 字段缺失");
    }
    return { version: INDEX_VERSION, jobs: parsed.jobs };
  } catch (error) {
    console.error("[自动化任务] 读取索引失败:", error);
    backupCorruptIndex(indexPath);
    return { version: INDEX_VERSION, jobs: [] };
  }
}

function writeIndex(index: AutomationJobsIndex): void {
  const indexPath = getAutomationJobsPath();
  writeJsonAtomic(indexPath, JSON.stringify(index, null, 2));
}

function validateSchedule(schedule: AutomationSchedule): void {
  if (!schedule || typeof schedule !== "object") {
    throw new Error("schedule 无效");
  }
  if (schedule.type === "cron") {
    if (!schedule.cronExpr || !schedule.cronExpr.trim()) {
      throw new Error("cron 类型任务缺少 cronExpr");
    }
    return;
  }
  if (schedule.type === "once") {
    if (typeof schedule.runAt !== "number" || !Number.isFinite(schedule.runAt) || schedule.runAt <= 0) {
      throw new Error("once 类型任务缺少有效 runAt");
    }
    return;
  }
  if (schedule.type === "interval") {
    if (typeof schedule.intervalMs !== "number" || !Number.isFinite(schedule.intervalMs) || schedule.intervalMs <= 0) {
      throw new Error("interval 类型任务缺少有效 intervalMs");
    }
    return;
  }
  throw new Error(`不支持的 schedule.type: ${(schedule as { type?: string }).type ?? "unknown"}`);
}

function normalizeName(name: string): string {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) {
    throw new Error("任务名称不能为空");
  }
  return trimmed;
}

function normalizePrompt(prompt: string): string {
  const trimmed = String(prompt ?? "").trim();
  if (!trimmed) {
    throw new Error("任务提示词不能为空");
  }
  return trimmed;
}

export function listAutomationJobs(): AutomationJob[] {
  return readIndex().jobs.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createAutomationJob(input: AutomationCreateJobInput): AutomationJob {
  const index = readIndex();
  validateSchedule(input.schedule);
  const now = Date.now();
  const job: AutomationJob = {
    id: randomUUID(),
    name: normalizeName(input.name),
    enabled: input.enabled ?? true,
    workspaceId: input.workspaceId?.trim() || undefined,
    sessionId: input.sessionId?.trim() || undefined,
    schedule: input.schedule,
    prompt: normalizePrompt(input.prompt),
    createdAt: now,
    updatedAt: now
  };
  index.jobs.push(job);
  writeIndex(index);
  return job;
}

export function updateAutomationJob(input: AutomationUpdateJobInput): AutomationJob {
  const index = readIndex();
  const targetIndex = index.jobs.findIndex((item) => item.id === input.id);
  if (targetIndex < 0) {
    throw new Error(`自动化任务不存在: ${input.id}`);
  }
  const existing = index.jobs[targetIndex] as AutomationJob;
  if (input.schedule) {
    validateSchedule(input.schedule);
  }
  const updated: AutomationJob = {
    ...existing,
    ...(input.name !== undefined ? { name: normalizeName(input.name) } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId.trim() || undefined } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId.trim() || undefined } : {}),
    ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
    ...(input.prompt !== undefined ? { prompt: normalizePrompt(input.prompt) } : {}),
    updatedAt: Date.now()
  };
  index.jobs[targetIndex] = updated;
  writeIndex(index);
  return updated;
}

export function deleteAutomationJob(input: AutomationDeleteJobInput): { ok: true } {
  const index = readIndex();
  const next = index.jobs.filter((item) => item.id !== input.id);
  if (next.length === index.jobs.length) {
    throw new Error(`自动化任务不存在: ${input.id}`);
  }
  writeIndex({ ...index, jobs: next });
  return { ok: true };
}
