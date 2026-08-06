import { closeSync, existsSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SDKMessage } from "@lume/agent-sdk";
import { AGENT_IPC_CHANNELS, type LumeRuntimeEvent } from "@lume/shared";
import { appendAgentThreadSDKMessages } from "../agent/agent-thread-manager";
import { emitAgentNotification } from "../agent/agent-notification-service";
import { organizeMemoryEntries } from "./entry-organizer";
import { rebuildDerivedMemoryViews } from "./derived-views";
import { memoryJobService, type MemoryJobRecord } from "./job-service";
import { getMemoryV2ScopePaths } from "./paths";
import { getMemoryRuntimeConfig } from "./policy";

const AUTO_DREAM_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const AUTO_DREAM_MIN_NEW_SESSIONS = 5;

interface ConsolidationState {
  lastCompletedAt?: number;
  completedRunCount: number;
  lastJobId?: string;
}

export interface ConsolidationResult {
  scannedEntries: number;
  updated: number;
  merged: number;
  stale: number;
  rebuilt: string[];
}

interface ConsolidationNotificationContext {
  threadId: string;
  runId: string;
}

export function maybeEnqueueAutoDream(
  workspaceSlug: string,
  context?: ConsolidationNotificationContext
): MemoryJobRecord<ConsolidationResult> | undefined {
  if (!getMemoryRuntimeConfig().autoDream) return undefined;
  return enqueueConsolidation(workspaceSlug, false, context);
}

export function enqueueConsolidation(
  workspaceSlug: string,
  manual = true,
  context?: ConsolidationNotificationContext
): MemoryJobRecord<ConsolidationResult> | undefined {
  const paths = getMemoryV2ScopePaths({ scope: "workspace", workspaceSlug });
  const globalPaths = getMemoryV2ScopePaths({ scope: "global" });
  const state = readState(paths.jobsDir);
  const completedRunCount = countRunEvidence(paths.runsDir);
  const elapsed = Date.now() - (state.lastCompletedAt ?? 0);
  const newSessions = completedRunCount - state.completedRunCount;
  if (!manual && (elapsed < AUTO_DREAM_INTERVAL_MS || newSessions < AUTO_DREAM_MIN_NEW_SESSIONS)) {
    return undefined;
  }
  const idempotencyKey = manual
    ? `consolidation:manual:${randomUUID()}`
    : `consolidation:auto:${completedRunCount}`;
  return memoryJobService.start<ConsolidationResult, {
    label: string;
    scannedItems: number;
    processedItems: number;
  }>({
    kind: "consolidation",
    workspaceSlug,
    idempotencyKey,
    manual,
    run: async ({ signal, report }) => withScopeLock(paths.jobsDir, () => withScopeLock(globalPaths.jobsDir, async () => {
      report({ label: "读取索引、主题摘要和近期证据", scannedItems: 0, processedItems: 0 });
      if (signal.aborted) throw new Error("记忆整理已取消");
      const organized = await organizeMemoryEntries({
        workspaceSlug,
        onProgress: (progress) => report(progress)
      });
      if (signal.aborted) throw new Error("记忆整理已取消");
      report({
        label: "重建主题摘要、工作区简报与用户画像",
        scannedItems: organized.scannedEntries,
        processedItems: organized.keptEntries
      });
      await rebuildDerivedMemoryViews({ scope: "workspace", workspaceSlug });
      await rebuildDerivedMemoryViews({ scope: "global" });
      return {
        scannedEntries: organized.scannedEntries,
        updated: 0,
        merged: organized.supersededDuplicates,
        stale: 0,
        rebuilt: ["capsules", "workspace-brief.md", "persona.md", "MEMORY.md"]
      };
    })),
    onProgress: (job) => {
      if (context && job.progress) notifyProgress(context, job.jobId, job.progress);
    },
    onCompleted: (job) => {
      writeState(paths.jobsDir, {
        lastCompletedAt: job.completedAt ?? Date.now(),
        completedRunCount,
        lastJobId: job.jobId
      });
      if (context && job.result) notifyCompleted(context, workspaceSlug, job.jobId, job.result);
    }
  });
}

function notifyProgress(
  context: ConsolidationNotificationContext,
  jobId: string,
  progress: { label: string; scannedItems: number; processedItems: number }
): void {
  const event: Extract<LumeRuntimeEvent, { type: "memory.job.progress" }> = {
    id: `${jobId}:progress:${progress.processedItems}`,
    type: "memory.job.progress",
    threadId: context.threadId,
    runId: context.runId,
    createdAt: new Date().toISOString(),
    jobId,
    jobKind: "consolidation",
    phase: progress.label,
    scannedItems: progress.scannedItems,
    processedItems: progress.processedItems,
    changedItems: 0
  };
  emitAgentNotification(AGENT_IPC_CHANNELS.RUNTIME_EVENT, { threadId: context.threadId, event });
}

function notifyCompleted(
  context: ConsolidationNotificationContext,
  workspaceSlug: string,
  jobId: string,
  result: ConsolidationResult
): void {
  const changedItems = result.updated + result.merged + result.stale;
  const summary = `整理了 ${changedItems} 条记忆 · 更新 ${result.updated} · 合并 ${result.merged} · 标记过期 ${result.stale}`;
  const createdAt = new Date().toISOString();
  const message: SDKMessage = {
    type: "system",
    subtype: "memory_saved",
    session_id: context.threadId,
    run_id: context.runId,
    workspace_slug: workspaceSlug,
    mutation_ids: [],
    memory_ids: [],
    summary,
    created_at: createdAt,
    details: [],
    uuid: randomUUID()
  };
  appendAgentThreadSDKMessages(context.threadId, [message]);
  const event: Extract<LumeRuntimeEvent, { type: "memory.job.completed" }> = {
    id: `${jobId}:completed`,
    type: "memory.job.completed",
    threadId: context.threadId,
    runId: context.runId,
    createdAt,
    jobId,
    jobKind: "consolidation",
    status: "completed",
    summary,
    changedItems
  };
  emitAgentNotification(AGENT_IPC_CHANNELS.RUNTIME_EVENT, { threadId: context.threadId, event });
}

function countRunEvidence(runsDir?: string): number {
  if (!runsDir || !existsSync(runsDir)) return 0;
  return readdirSync(runsDir).filter((name) => name.endsWith(".jsonl")).length;
}

async function withScopeLock<TResult>(jobsDir: string, run: () => Promise<TResult>): Promise<TResult> {
  const lockPath = join(jobsDir, "consolidation.lock");
  acquireScopeLock(lockPath);
  try {
    return await run();
  } finally {
    if (existsSync(lockPath)) unlinkSync(lockPath);
  }
}

function acquireScopeLock(lockPath: string): void {
  try {
    const fd = openSync(lockPath, "wx");
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf-8");
    } finally {
      closeSync(fd);
    }
    return;
  } catch {
    const owner = readLockOwner(lockPath);
    if (owner && !isProcessAlive(owner.pid)) {
      unlinkSync(lockPath);
      return acquireScopeLock(lockPath);
    }
    throw new Error("当前作用域已有记忆整理任务在运行");
  }
}

function readLockOwner(path: string): { pid: number } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { pid?: unknown };
    return typeof parsed.pid === "number" ? { pid: parsed.pid } : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function statePath(jobsDir: string): string {
  return join(jobsDir, "consolidation-state.json");
}

function readState(jobsDir: string): ConsolidationState {
  try {
    return JSON.parse(readFileSync(statePath(jobsDir), "utf-8")) as ConsolidationState;
  } catch {
    return { completedRunCount: 0 };
  }
}

function writeState(jobsDir: string, state: ConsolidationState): void {
  const path = statePath(jobsDir);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  renameSync(temp, path);
}
