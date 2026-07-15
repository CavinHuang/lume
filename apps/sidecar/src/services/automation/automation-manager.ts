import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AutomationCreateJobInput,
  AutomationDeleteJobInput,
  DailyRoutine,
  AutomationJob,
  AutomationJobsIndex,
  AutomationUpdateJobInput
} from "@lume/shared";
import { getAutomationJobsPath, getConfigDir } from "../infra/config-paths";
import { getNextAutomationRunAt, validateAutomationSchedule } from "./automation-schedule";

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

function listRoutineAutomationJobIds(): Set<string> {
  const ids = new Set<string>();
  const dir = join(getConfigDir(), "routine", "schedules");
  if (!existsSync(dir)) return ids;
  for (const filename of readdirSync(dir)) {
    if (!filename.endsWith(".json")) continue;
    try {
      const routine = JSON.parse(readFileSync(join(dir, filename), "utf-8")) as DailyRoutine;
      for (const entry of routine.entries ?? []) {
        if (entry.automationJobId) ids.add(entry.automationJobId);
      }
    } catch {
      // ignore broken routine schedules here; routine-store owns detailed recovery
    }
  }
  return ids;
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
  const routineJobIds = listRoutineAutomationJobIds();
  return readIndex().jobs
    .map((job) => (
      routineJobIds.has(job.id) && !job.systemAction
        ? { ...job, source: "system" as const, systemAction: "routine" as const }
        : job
    ))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createAutomationJob(input: AutomationCreateJobInput): AutomationJob {
  const index = readIndex();
  validateAutomationSchedule(input.schedule);
  const now = Date.now();
  const enabled = input.enabled ?? true;
  const job: AutomationJob = {
    id: randomUUID(),
    name: normalizeName(input.name),
    enabled,
    workspaceId: input.workspaceId?.trim() || undefined,
    threadId: input.threadId?.trim() || undefined,
    schedule: input.schedule,
    ...(input.triggerModes ? { triggerModes: input.triggerModes } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.systemAction ? { systemAction: input.systemAction } : {}),
    ...(input.description ? { description: input.description.trim() } : {}),
    ...(input.defaultModel ? { defaultModel: input.defaultModel.trim() } : {}),
    ...(input.toolResourceIds ? { toolResourceIds: input.toolResourceIds } : {}),
    prompt: normalizePrompt(input.prompt),
    nextRunAt: enabled ? getNextAutomationRunAt(input.schedule, now) : null,
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
    validateAutomationSchedule(input.schedule);
  }
  const schedule = input.schedule ?? existing.schedule;
  const enabled = input.enabled ?? existing.enabled;
  const updatedAt = Date.now();
  const shouldRecomputeNextRun = input.schedule !== undefined
    || input.enabled !== undefined
    || existing.nextRunAt === undefined;
  const updated: AutomationJob = {
    ...existing,
    ...(input.name !== undefined ? { name: normalizeName(input.name) } : {}),
    enabled,
    ...(input.disabledReason !== undefined ? { disabledReason: input.disabledReason.trim() || undefined } : {}),
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId.trim() || undefined } : {}),
    ...(input.threadId !== undefined ? { threadId: input.threadId.trim() || undefined } : {}),
    schedule,
    ...(input.triggerModes !== undefined ? { triggerModes: input.triggerModes } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.systemAction !== undefined ? { systemAction: input.systemAction } : {}),
    ...(input.description !== undefined ? { description: input.description.trim() || undefined } : {}),
    ...(input.defaultModel !== undefined ? { defaultModel: input.defaultModel.trim() || undefined } : {}),
    ...(input.toolResourceIds !== undefined ? { toolResourceIds: input.toolResourceIds } : {}),
    ...(input.prompt !== undefined ? { prompt: normalizePrompt(input.prompt) } : {}),
    ...(shouldRecomputeNextRun ? { nextRunAt: enabled ? getNextAutomationRunAt(schedule, updatedAt) : null } : {}),
    updatedAt
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

export function recordAutomationJobRun(input: { id: string; startedAt: number }): AutomationJob {
  const index = readIndex();
  const targetIndex = index.jobs.findIndex((item) => item.id === input.id);
  if (targetIndex < 0) {
    throw new Error(`自动化任务不存在: ${input.id}`);
  }
  const existing = index.jobs[targetIndex] as AutomationJob;
  const updated: AutomationJob = {
    ...existing,
    lastRunAt: input.startedAt,
    nextRunAt: existing.enabled ? getNextAutomationRunAt(existing.schedule, input.startedAt) : null,
    updatedAt: Date.now()
  };
  index.jobs[targetIndex] = updated;
  writeIndex(index);
  return updated;
}

export function listAutomationJobsReferencingProject(input: {
  workspaceId: string;
  threadIds?: Set<string>;
}): AutomationJob[] {
  const threadIds = input.threadIds ?? new Set<string>();
  return readIndex().jobs.filter((job) =>
    job.workspaceId === input.workspaceId
    || (typeof job.threadId === "string" && threadIds.has(job.threadId))
  );
}

export function disableAutomationJobsReferencingProject(input: {
  workspaceId: string;
  threadIds?: Set<string>;
  reason: string;
}): AutomationJob[] {
  const threadIds = input.threadIds ?? new Set<string>();
  const index = readIndex();
  const now = Date.now();
  let changed = false;
  const updatedJobs = index.jobs.map((job) => {
    const affected = job.workspaceId === input.workspaceId
      || (typeof job.threadId === "string" && threadIds.has(job.threadId));
    if (!affected) return job;
    changed = true;
    return {
      ...job,
      enabled: false,
      disabledReason: input.reason,
      nextRunAt: null,
      updatedAt: now
    } satisfies AutomationJob;
  });
  if (changed) {
    writeIndex({ ...index, jobs: updatedJobs });
  }
  return updatedJobs.filter((job) =>
    job.workspaceId === input.workspaceId
    || (typeof job.threadId === "string" && threadIds.has(job.threadId))
  );
}
