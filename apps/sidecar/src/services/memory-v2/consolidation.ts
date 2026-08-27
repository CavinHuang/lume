import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SDKMessage } from "@lume/agent-sdk";
import { AGENT_IPC_CHANNELS, type LumeRuntimeEvent, type MemoryDreamResult, type MemoryOrganizeProgress } from "@lume/shared";
import { appendAgentThreadSDKMessages } from "../agent/agent-thread-manager";
// #580 review fix:出站通知直连 infra 单点,不经 agent 域借道。
import { getOutboundNotificationWriter } from "../infra/outbound-notification";
import { runDreamOrganizer } from "./dream-organizer";
import { buildDreamEvidenceWindow, type DreamEvidenceCursor } from "./dream-evidence";
import { rebuildDerivedMemoryViews } from "./derived-views";
import { memoryJobService, type MemoryJobRecord } from "./job-service";
import { getMemoryV2ScopePaths } from "./paths";
import { getMemoryRuntimeConfig } from "./policy";

const AUTO_DREAM_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const AUTO_DREAM_MIN_NEW_SESSIONS = 5;

interface ConsolidationState {
  lastSuccessfulAt?: number;
  evidenceCursor?: number | DreamEvidenceCursor;
  lastJobId?: string;
  /** Legacy fields are read conservatively and replaced after the next success. */
  lastCompletedAt?: number;
  completedRunCount?: number;
}

interface ConsolidationNotificationContext {
  threadId: string;
  runId: string;
  modelRef?: string;
}

export function maybeEnqueueAutoDream(
  workspaceSlug: string,
  context?: ConsolidationNotificationContext
): MemoryJobRecord<MemoryDreamResult> | undefined {
  if (!getMemoryRuntimeConfig().autoDream) return undefined;
  return enqueueConsolidation(workspaceSlug, false, context);
}

export function enqueueConsolidation(
  workspaceSlug: string,
  manual = true,
  context?: ConsolidationNotificationContext,
  options?: { force?: boolean; evidenceWindow?: ReturnType<typeof buildDreamEvidenceWindow> }
): MemoryJobRecord<MemoryDreamResult> | undefined {
  const paths = getMemoryV2ScopePaths({ scope: "workspace", workspaceSlug });
  const globalPaths = getMemoryV2ScopePaths({ scope: "global" });
  const state = readState(paths.jobsDir);
  // Legacy state tracked only a file count, so it cannot prove which conversations were reviewed.
  // Re-read from the beginning once, then persist the precise evidence cursor after success.
  const evidenceCursor = state.evidenceCursor ?? 0;
  const upperBound = Date.now();
  const evidenceWindow = options?.evidenceWindow ?? buildDreamEvidenceWindow({
      workspaceSlug,
      cursor: evidenceCursor,
      upperBound,
      triggeringThreadId: context?.threadId
    });
  const elapsed = Date.now() - (state.lastSuccessfulAt ?? state.lastCompletedAt ?? 0);
  if (!manual && !options?.force && (elapsed < AUTO_DREAM_INTERVAL_MS || evidenceWindow.sessionsAvailable < AUTO_DREAM_MIN_NEW_SESSIONS)) {
    return undefined;
  }
  const idempotencyKey = manual
    ? `consolidation:manual:${randomUUID()}`
    : `consolidation:auto:${evidenceWindow.from}:${evidenceWindow.fromRunId ?? ""}:${evidenceWindow.to}:${evidenceWindow.toRunId ?? ""}`;
  return memoryJobService.start<MemoryDreamResult, MemoryOrganizeProgress>({
    kind: "consolidation",
    workspaceSlug,
    idempotencyKey,
    manual,
    payload: {
      workspaceSlug,
      manual,
      trigger: context ? "run" : "settings",
      evidenceWindow,
      ...(context ? { context } : {})
    },
    run: async ({ jobId, signal, report }) => withScopeLock(paths.jobsDir, () => withScopeLock(globalPaths.jobsDir, async () => {
      report({ label: "读取索引、主题摘要和近期证据", scannedItems: 0, processedItems: 0 });
      if (signal.aborted) throw new Error("记忆整理已取消");
      const organized = await runDreamOrganizer({
        workspaceSlug,
        jobId,
        evidenceWindow,
        signal,
        ...(context ? {
          ...(context.modelRef ? { modelRef: context.modelRef } : {}),
          agentContext: { threadId: context.threadId, runId: context.runId }
        } : {}),
        onProgress: (progress) => report(progress)
      });
      if (signal.aborted) throw new Error("记忆整理已取消");
      report({
        label: "重建主题摘要、工作区简报与关于我",
        scannedItems: organized.scannedEntries,
        processedItems: organized.items.length,
        changedItems: changedItemCount(organized),
        changedFiles: ["capsules", "workspace-brief.md", "persona.md", "MEMORY.md"]
      });
      const rebuilt = [
        ...await rebuildDerivedMemoryViews({ scope: "workspace", workspaceSlug }),
        ...await rebuildDerivedMemoryViews({ scope: "global" })
      ];
      return { ...organized, rebuilt };
    })),
    onProgress: (job) => {
      if (context && job.progress) notifyProgress(context, job.jobId, job.progress);
    },
    onCompleted: (job) => {
      writeState(paths.jobsDir, {
        lastSuccessfulAt: job.completedAt ?? Date.now(),
        evidenceCursor: evidenceWindow.runIds.length > 0
          ? { createdAt: evidenceWindow.to, runId: evidenceWindow.toRunId ?? "" }
          : evidenceCursor,
        lastJobId: job.jobId
      });
      if (context && job.result && changedItemCount(job.result) > 0) notifyCompleted(context, workspaceSlug, job.jobId, job.result);
      if (evidenceWindow.hasMore) enqueueConsolidation(workspaceSlug, false, context, { force: true });
    }
  });
}

/** Re-queue a consolidation interrupted by a process restart with its captured evidence bound. */
export function recoverInterruptedConsolidation(workspaceSlug: string): boolean {
  const interrupted = memoryJobService.list(workspaceSlug).find((job) =>
    job.kind === "consolidation" && job.status === "interrupted"
  );
  if (!interrupted) return false;
  const payload = interrupted.payload && typeof interrupted.payload === "object"
    ? interrupted.payload as {
        manual?: boolean;
        context?: ConsolidationNotificationContext;
        evidenceWindow?: ReturnType<typeof buildDreamEvidenceWindow>;
      }
    : undefined;
  return Boolean(enqueueConsolidation(
    workspaceSlug,
    payload?.manual ?? interrupted.manual,
    payload?.context,
    { force: true, evidenceWindow: payload?.evidenceWindow }
  ));
}

function notifyProgress(
  context: ConsolidationNotificationContext,
  jobId: string,
  progress: MemoryOrganizeProgress
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
  getOutboundNotificationWriter()?.(AGENT_IPC_CHANNELS.RUNTIME_EVENT, { threadId: context.threadId, event });
}

function notifyCompleted(
  context: ConsolidationNotificationContext,
  workspaceSlug: string,
  jobId: string,
  result: MemoryDreamResult
): void {
  const changedItems = changedItemCount(result);
  const summary = `整理了 ${changedItems} 条记忆 · 新增 ${result.actions.created} · 更新 ${result.actions.versioned + result.actions.updated} · 合并 ${result.actions.merged} · 标记过期 ${result.actions.stale} · 待处理 ${result.actions.pending}`;
  const createdAt = new Date().toISOString();
  // uuid 段必须与落盘消息同一 uuid：replay 投影公式为
  // `${run_id}:memory.changed:${mutation_ids[0] ?? uuid}`（consolidation 恒无 mutation_ids），
  // live 与 replay 同 id → 前端 upsert 去重，刷新后不再突现幽灵消息。
  const messageUuid = randomUUID();
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
    uuid: messageUuid
  };
  appendAgentThreadSDKMessages(context.threadId, [message]);
  const memoryChangedEvent: Extract<LumeRuntimeEvent, { type: "memory.changed" }> = {
    id: `${context.runId}:memory.changed:${messageUuid}`,
    type: "memory.changed",
    threadId: context.threadId,
    runId: context.runId,
    createdAt,
    actor: "consolidation",
    workspaceSlug,
    mutationIds: [],
    memoryIds: [],
    summary,
    details: []
  };
  getOutboundNotificationWriter()?.(AGENT_IPC_CHANNELS.RUNTIME_EVENT, { threadId: context.threadId, event: memoryChangedEvent });
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
  getOutboundNotificationWriter()?.(AGENT_IPC_CHANNELS.RUNTIME_EVENT, { threadId: context.threadId, event });
}

function changedItemCount(result: MemoryDreamResult): number {
  return result.actions.created
    + result.actions.versioned
    + result.actions.updated
    + result.actions.merged
    + result.actions.stale
    + result.actions.pending;
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
    return {};
  }
}

function writeState(jobsDir: string, state: ConsolidationState): void {
  const path = statePath(jobsDir);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  renameSync(temp, path);
}
