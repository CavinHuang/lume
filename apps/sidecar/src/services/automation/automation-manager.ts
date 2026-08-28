import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  AutomationCreateJobInput,
  AutomationDeleteJobInput,
  DailyRoutine,
  AutomationJob,
  AutomationJobsIndex,
  AutomationUpdateJobInput,
  AutomationJobProvenance
} from "@lume/shared";
import { getAutomationJobsPath, getConfigDir } from "../infra/config-paths";
import { withIndexMutationLock } from "../infra/index-mutation-lock";
import { getNextAutomationRunAt, validateAutomationSchedule } from "./automation-schedule";
import { createLogger } from "../infra/logger";

const INDEX_VERSION = 1;
const log = createLogger("automation-manager");

// #518:与全仓其他 index 型 store 对齐的纵深防御锁——单线程同步 RMW 下进程内
// 不竞争,防的是接管重叠窗的双写者互相覆盖
function automationIndexLockPath(): string {
  return `${getAutomationJobsPath()}.lock`;
}

function writeJsonAtomic(path: string, payload: string): void {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

// #647 P2-22：索引损坏检疫态——备份后原文件保留在位，写操作全部阻止，
// 防"备份后回退空表→下一次写入静默覆盖存量任务"；用户修复或删除文件即解除
let corruptIndexQuarantined = false;

function backupCorruptIndex(indexPath: string): void {
  if (!existsSync(indexPath)) return;
  const dir = dirname(indexPath);
  const prefix = `${basename(indexPath)}.corrupt-`;
  const files = existsSync(dir) ? readdirSync(dir) : [];
  let currentContent: string;
  try {
    currentContent = readFileSync(indexPath, "utf-8");
  } catch {
    return;
  }
  // #686：同代备份（内容与当前损坏文件相同）已存在则跳过——防重启堆积副本；
  // 判代用内容比对而非 mtime：CI 文件系统 mtime 粒度可达 4ms，同毫秒落盘的
  // 旧备份会被误判为当前代而抑制新备份。旧代备份不抑制新一代备份，避免按
  // "删除"指引恢复时丢失代间新建的任务
  const hasCurrentGenBackup = files.some((name) => {
    if (!name.startsWith(prefix)) return false;
    try {
      return readFileSync(join(dir, name), "utf-8") === currentContent;
    } catch {
      return false;
    }
  });
  if (hasCurrentGenBackup) return;
  // 备份名带随机后缀：裸 Date.now() 在同毫秒内创建两代备份时文件名碰撞，
  // 后写覆盖先写、第一代唯一数据副本静默丢失（#686 回归钉在 CI 实证；本 PR 曾以
  // hrtime.bigint() 独立修复同一问题，合并取 main 的 randomUUID 形态保单源）。
  const backupPath = `${indexPath}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
  try {
    copyFileSync(indexPath, backupPath);
    log.warn("backed up corrupt automation index", { backupPath });
  } catch (error) {
    log.warn("failed to back up corrupt automation index", { error, backupPath });
  }
}

function readIndex(): AutomationJobsIndex {
  const indexPath = getAutomationJobsPath();
  if (!existsSync(indexPath)) {
    corruptIndexQuarantined = false;
    return { version: INDEX_VERSION, jobs: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf-8")) as AutomationJobsIndex;
    if (!Array.isArray(parsed.jobs)) {
      throw new Error("jobs 字段缺失");
    }
    corruptIndexQuarantined = false;
    return { version: INDEX_VERSION, jobs: parsed.jobs };
  } catch (error) {
    log.error("failed to read automation index", { error, indexPath });
    backupCorruptIndex(indexPath);
    corruptIndexQuarantined = true;
    return { version: INDEX_VERSION, jobs: [] };
  }
}

function writeIndex(index: AutomationJobsIndex): void {
  if (corruptIndexQuarantined) {
    throw new Error(
      `自动化任务索引已损坏并备份，为防覆盖存量任务已暂停写入；请修复或删除 ${getAutomationJobsPath()} 后重试`,
    );
  }
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
  return withIndexMutationLock(automationIndexLockPath(), () => {
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
      scheduleAnchorAt: now,
      ...(input.triggerModes ? { triggerModes: input.triggerModes } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.systemAction ? { systemAction: input.systemAction } : {}),
      ...(input.description ? { description: input.description.trim() } : {}),
      ...(input.defaultModel ? { defaultModel: input.defaultModel.trim() } : {}),
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
      ...(input.toolResourceIds ? { toolResourceIds: input.toolResourceIds } : {}),
      prompt: normalizePrompt(input.prompt),
      nextRunAt: enabled ? getNextAutomationRunAt(input.schedule, now, now) : null,
      createdAt: now,
      updatedAt: now
    };
    index.jobs.push(job);
    writeIndex(index);
    return job;
  });
}

/** Internal-only provenance write; public automation schemas never accept this field. */
export function setAutomationJobProvenance(jobId: string, provenance: AutomationJobProvenance): AutomationJob {
  return withIndexMutationLock(automationIndexLockPath(), () => {
      const index = readIndex();
      const target = index.jobs.find((job) => job.id === jobId);
      if (!target) throw new Error(`自动化任务不存在: ${jobId}`);
      if (target.provenance && JSON.stringify(target.provenance) !== JSON.stringify(provenance)) throw new Error("automation provenance is immutable");
      const updated = { ...target, provenance, updatedAt: Date.now() };
      index.jobs = index.jobs.map((job) => job.id === jobId ? updated : job);
      writeIndex(index);
      return updated;
  });
}

export function updateAutomationJob(input: AutomationUpdateJobInput): AutomationJob {
  return withIndexMutationLock(automationIndexLockPath(), () => {
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
      scheduleAnchorAt: input.schedule !== undefined ? updatedAt : (existing.scheduleAnchorAt ?? existing.createdAt),
      ...(input.triggerModes !== undefined ? { triggerModes: input.triggerModes } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.systemAction !== undefined ? { systemAction: input.systemAction } : {}),
      ...(input.description !== undefined ? { description: input.description.trim() || undefined } : {}),
      ...(input.defaultModel !== undefined ? { defaultModel: input.defaultModel.trim() || undefined } : {}),
      ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
      ...(input.toolResourceIds !== undefined ? { toolResourceIds: input.toolResourceIds } : {}),
      ...(input.prompt !== undefined ? { prompt: normalizePrompt(input.prompt) } : {}),
      ...(shouldRecomputeNextRun ? { nextRunAt: enabled ? getNextAutomationRunAt(schedule, updatedAt, input.schedule !== undefined ? updatedAt : (existing.scheduleAnchorAt ?? existing.createdAt)) : null } : {}),
      updatedAt
    };
    index.jobs[targetIndex] = updated;
    writeIndex(index);
    return updated;
  });
}

export function deleteAutomationJob(input: AutomationDeleteJobInput): { ok: true } {
  return withIndexMutationLock(automationIndexLockPath(), () => {
    const index = readIndex();
    const next = index.jobs.filter((item) => item.id !== input.id);
    if (next.length === index.jobs.length) {
      throw new Error(`自动化任务不存在: ${input.id}`);
    }
    writeIndex({ ...index, jobs: next });
    return { ok: true };
  });
}

export function recordAutomationJobRun(input: { id: string; startedAt: number }): AutomationJob {
  return withIndexMutationLock(automationIndexLockPath(), () => {
    const index = readIndex();
    const targetIndex = index.jobs.findIndex((item) => item.id === input.id);
    if (targetIndex < 0) {
      throw new Error(`自动化任务不存在: ${input.id}`);
    }
    const existing = index.jobs[targetIndex] as AutomationJob;
    const updated: AutomationJob = {
      ...existing,
      lastRunAt: input.startedAt,
      nextRunAt: existing.enabled ? getNextAutomationRunAt(existing.schedule, input.startedAt, existing.scheduleAnchorAt ?? existing.createdAt) : null,
      updatedAt: Date.now()
    };
    index.jobs[targetIndex] = updated;
    writeIndex(index);
    return updated;
  });
}

export function advanceAutomationJobSchedule(input: { id: string; fromAt: number }): AutomationJob {
  return withIndexMutationLock(automationIndexLockPath(), () => {
    const index = readIndex();
    const targetIndex = index.jobs.findIndex((item) => item.id === input.id);
    if (targetIndex < 0) throw new Error(`自动化任务不存在: ${input.id}`);
    const existing = index.jobs[targetIndex] as AutomationJob;
    const updated: AutomationJob = {
      ...existing,
      nextRunAt: existing.enabled
        ? getNextAutomationRunAt(existing.schedule, input.fromAt, existing.scheduleAnchorAt ?? existing.createdAt)
        : null,
      updatedAt: Date.now()
    };
    index.jobs[targetIndex] = updated;
    writeIndex(index);
    return updated;
  });
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
  return withIndexMutationLock(automationIndexLockPath(), () => {
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
  });
}
