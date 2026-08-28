import { createLogger } from "../../infra/logger";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { getAgentConfigDir } from "../../infra/config-paths";
import { backupCorruptFile } from "../../infra/corrupt-file-backup";
import {
  SUBAGENT_RUN_STORE_VERSION,
  type CreateSubagentRunInput,
  type SubagentRun,
  type SubagentRunStatus,
  type SubagentRunStoreSchema,
  type UpdateSubagentRunInput
} from "./subagent-run-types";

// ─── Observability helpers (migrated from subagent-observability.ts) ───

type LogFields = Record<string, unknown>;

function compactFields(fields: LogFields): LogFields {
  const cleaned: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue;
    cleaned[key] = value;
  }
  return cleaned;
}

export function subagentLogFields(
  run: Partial<SubagentRun>,
  extra?: LogFields
): LogFields {
  return compactFields({
    runId: run.runId,
    parentRunId: run.parentRunId,
    rootThreadId: run.rootThreadId,
    sessionId: run.parentThreadId,
    parentThreadId: run.parentThreadId,
    childThreadId: run.childThreadId,
    deliveryThreadId: run.deliveryThreadId,
    requestedAgentId: run.requestedAgentId,
    resolvedAgentId: run.resolvedAgentId,
    status: run.status,
    errorCode: run.outcome?.errorCode,
    ...extra
  });
}

// ─── Registry ───

const log = createLogger("subagent-run-registry");
const MAX_PERSISTED_RUNS = 500;
const STALE_SUBAGENT_ERROR = "Sidecar 进程重启，之前的进程内 subagent 已退出。";

function cloneRun(run: SubagentRun): SubagentRun {
  return {
    ...run,
    ...(run.runtimeRunIds ? { runtimeRunIds: [...run.runtimeRunIds] } : {}),
    outcome: run.outcome ? { ...run.outcome } : undefined
  };
}

function buildRunStatusSummary(runs: SubagentRun[]): Record<SubagentRunStatus, number> {
  const summary: Record<SubagentRunStatus, number> = {
    accepted: 0,
    running: 0,
    completed: 0,
    errored: 0,
    aborted: 0,
    timed_out: 0,
    canceled: 0
  };
  for (const run of runs) {
    summary[run.status] += 1;
  }
  return summary;
}

type DelegationCompletion = { completion: Promise<void>; resolve: () => void };

class SubagentRunRegistry {
  private runs = new Map<string, SubagentRun>();
  private loadDone = false;
  private readonly terminalStatuses = new Set(["completed", "errored", "aborted", "timed_out", "canceled"]);
  private delegationCompletions = new Map<string, DelegationCompletion>();

  private ensureLoaded(): void {
    if (this.loadDone) return;
    const store = readSubagentRunStore();
    let finalizedStaleRuns = 0;
    const now = Date.now();
    for (const run of store.runs) {
      const restoredRun = this.terminalStatuses.has(run.status)
        ? run
        : {
            ...run,
            status: "errored" as const,
            updatedAt: now,
            endedAt: run.endedAt ?? now,
            outcome: {
              ...run.outcome,
              error: run.outcome?.error ?? STALE_SUBAGENT_ERROR,
              errorCode: run.outcome?.errorCode ?? "process_restarted"
            }
          };
      if (restoredRun !== run) {
        finalizedStaleRuns += 1;
      }
      this.runs.set(restoredRun.runId, restoredRun);
    }
    this.loadDone = true;
    if (finalizedStaleRuns > 0) {
      this.persist();
      log.warn("subagent stale runs marked errored after registry load", {
        count: finalizedStaleRuns
      });
    }
  }

  // #616①:persist 全量 pretty-print 重写 0.5-1.5MB,一个 subagent 生命周期
  // 4-8 次状态变更线性叠加写放大。非关键变更(如 runtimeRunIds 追加、非状态
  // 字段 patch)标 dirty 由微批冲刷;创建与状态迁移保持同步落盘语义。
  private persistDirty = false;
  private persistScheduled = false;

  private schedulePersist(): void {
    this.persistDirty = true;
    if (this.persistScheduled) return;
    this.persistScheduled = true;
    queueMicrotask(() => {
      this.persistScheduled = false;
      if (!this.persistDirty) return;
      this.persistDirty = false;
      this.persist();
    });
  }

  private persist(): void {
    this.ensureLoaded();
    this.pruneMemoryRuns();
    const allRuns = Array.from(this.runs.values());
    const activeRuns = allRuns.filter((run) => !this.terminalStatuses.has(run.status));
    const terminalRuns = allRuns
      .filter((run) => this.terminalStatuses.has(run.status))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(0, MAX_PERSISTED_RUNS - activeRuns.length));
    // 未终态 run 是重启恢复的必要账本，不能被历史终态记录挤出磁盘上限。
    // 极端情况下 active 本身超过上限时允许临时超限，终态历史让位。
    const runs = [...activeRuns, ...terminalRuns]
      .sort((a, b) => a.updatedAt - b.updatedAt);
    try {
      writeSubagentRunStore({
        version: SUBAGENT_RUN_STORE_VERSION,
        runs
      });
    } catch (error) {
      log.error("持久化 subagent runs 失败", {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /** 内存 Map 与磁盘副本同口径裁剪:仅淘汰已终态的最老 run(运行中/未终态永不逐出)。 */
  private pruneMemoryRuns(): void {
    if (this.runs.size <= MAX_PERSISTED_RUNS * 2) return;
    const terminal = [...this.runs.values()]
      .filter((run) => this.terminalStatuses.has(run.status))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    const excess = Math.min(terminal.length, this.runs.size - MAX_PERSISTED_RUNS);
    for (let index = 0; index < excess; index += 1) {
      const run = terminal[index];
      if (run) this.runs.delete(run.runId);
    }
  }

  create(input: CreateSubagentRunInput): SubagentRun {
    this.ensureLoaded();
    const now = input.createdAt ?? Date.now();
    const run: SubagentRun = {
      runId: input.runId,
      parentThreadId: input.parentThreadId,
      parentRunId: input.parentRunId,
      rootThreadId: input.rootThreadId ?? input.parentThreadId,
      depth: typeof input.depth === "number" ? Math.max(0, Math.floor(input.depth)) : 1,
      childThreadId: input.childThreadId,
      deliveryThreadId: input.deliveryThreadId,
      threadRequested: input.threadRequested === true,
      threadBound: input.threadBound === true,
      background: input.background === true,
      label: input.label,
      task: input.task,
      status: input.status ?? "accepted",
      cleanup: input.cleanup,
      parentToolUseId: input.parentToolUseId,
      requestedAgentId: input.requestedAgentId,
      resolvedAgentId: input.resolvedAgentId,
      modelRef: input.modelRef,
      channelId: input.channelId,
      modelId: input.modelId,
      announceStatus: input.announceStatus,
      announceAttempts: input.announceAttempts,
      announceLastError: input.announceLastError,
      announceDeliveredAt: input.announceDeliveredAt,
      createdAt: now,
      updatedAt: now
    };
    this.runs.set(run.runId, run);
    this.persist();
    log.info("subagent run created", subagentLogFields(run, {
      event: "run_created"
    }));
    return cloneRun(run);
  }

  get(runId: string): SubagentRun | null {
    this.ensureLoaded();
    const run = this.runs.get(runId);
    return run ? cloneRun(run) : null;
  }

  listByParentSession(parentThreadId: string): SubagentRun[] {
    this.ensureLoaded();
    return Array.from(this.runs.values())
      .filter((run) => run.parentThreadId === parentThreadId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(cloneRun);
  }

  listByRootSession(rootThreadId: string): SubagentRun[] {
    this.ensureLoaded();
    return Array.from(this.runs.values())
      .filter((run) => run.rootThreadId === rootThreadId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(cloneRun);
  }

  listControlledByThread(ownerThreadId: string): SubagentRun[] {
    this.ensureLoaded();
    const merged = new Map<string, SubagentRun>();
    for (const run of this.runs.values()) {
      if (run.parentThreadId === ownerThreadId || run.rootThreadId === ownerThreadId) {
        merged.set(run.runId, cloneRun(run));
      }
    }
    return Array.from(merged.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  getLatestByChildThread(childThreadId: string): SubagentRun | null {
    this.ensureLoaded();
    const matched = Array.from(this.runs.values())
      .filter((run) => run.childThreadId === childThreadId)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    return matched ? cloneRun(matched) : null;
  }

  countActiveByParentSession(parentThreadId: string): number {
    this.ensureLoaded();
    return Array.from(this.runs.values()).filter((run) => (
      run.parentThreadId === parentThreadId && !this.terminalStatuses.has(run.status)
    )).length;
  }

  listActiveByParentSession(parentThreadId: string): SubagentRun[] {
    this.ensureLoaded();
    return Array.from(this.runs.values())
      .filter((run) => (
        run.parentThreadId === parentThreadId && !this.terminalStatuses.has(run.status)
      ))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(cloneRun);
  }

  listAll(limit = 200): SubagentRun[] {
    this.ensureLoaded();
    return Array.from(this.runs.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map(cloneRun);
  }

  summarizeStatuses(runs: SubagentRun[]): Record<SubagentRunStatus, number> {
    return buildRunStatusSummary(runs);
  }

  /**
   * 桥接 registry runId 与子线程 attempt 的 runtime runId(web 投影依赖)。
   * 已存在时 no-op 不写盘;高频事件下仅首次产生一次 persist。
   */
  bindRuntimeRun(runId: string, runtimeRunId: string): SubagentRun | null {
    this.ensureLoaded();
    const normalized = runtimeRunId.trim();
    if (!normalized) return this.runs.get(runId) ? cloneRun(this.runs.get(runId)!) : null;
    const existing = this.runs.get(runId);
    if (!existing) return null;
    const ids = existing.runtimeRunIds ?? [];
    if (ids.includes(normalized)) return cloneRun(existing);
    const next: SubagentRun = { ...existing, runtimeRunIds: [...ids, normalized], updatedAt: Date.now() };
    this.runs.set(runId, next);
    this.schedulePersist();
    return cloneRun(next);
  }

  update(runId: string, patch: UpdateSubagentRunInput): SubagentRun | null {
    this.ensureLoaded();
    const existing = this.runs.get(runId);
    if (!existing) return null;
    const previousStatus = existing.status;

    const next: SubagentRun = {
      ...existing,
      ...patch,
      outcome: patch.outcome ? { ...patch.outcome } : existing.outcome,
      updatedAt: Date.now()
    };

    if (patch.status === "running" && !next.startedAt) {
      next.startedAt = Date.now();
    }

    if (next.status && this.terminalStatuses.has(next.status) && !next.endedAt) {
      next.endedAt = Date.now();
    }

    this.runs.set(runId, next);
    // 状态迁移同步落盘(恢复语义关键);其余字段 patch 微批冲刷(#616①)
    if (next.status !== previousStatus || (next.status && this.terminalStatuses.has(next.status))) this.persist();
    else this.schedulePersist();
    if (next.status !== previousStatus) {
      const payload = subagentLogFields(next, {
        event: "run_status_changed",
        previousStatus,
        announceStatus: next.announceStatus
      });
      if (next.status === "errored" || next.status === "aborted" || next.status === "timed_out" || next.status === "canceled") {
        log.warn("subagent run reached non-success status", payload);
      } else {
        log.info("subagent run status updated", payload);
      }
    }
    return cloneRun(next);
  }

  // ─── Delegation completion signal (for async background delegations) ───

  /**
   * 为一次后台委派注册一个 completion Promise 信号量。
   * 由 delegate background 分支在启动子会话前调用，waitForDelegations 依赖它感知完成。
   */
  createDelegationCompletion(runId: string): void {
    if (this.delegationCompletions.has(runId)) return;
    let resolveFn!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });
    this.delegationCompletions.set(runId, { completion, resolve: resolveFn });
  }

  /**
   * 解析某次委派的 completion 信号量（唤醒等待方）。
   * 由 delegate background 分支在子会话结束/出错时调用。resolve 后立即移除条目，避免泄漏。
   */
  resolveDelegationCompletion(runId: string): void {
    const entry = this.delegationCompletions.get(runId);
    if (!entry) return;
    entry.resolve();
    this.delegationCompletions.delete(runId);
  }

  /**
   * 取得某次委派的 completion Promise（供 waitForDelegations 挂载 .then(check)）。
   */
  getDelegationCompletion(runId: string): Promise<void> | undefined {
    return this.delegationCompletions.get(runId)?.completion;
  }

  /**
   * 等待父会话下的委派子会话收敛。
   * - mode "all"：等待所有子会话进入终态；mode "any"：等待至少 minCompleted 个完成。
   * - 无 running 子会话时立即返回 completed。
   * - 超时返回 timeout，但返回时仍给出当前 completed/running 计数。
   */
  async waitForDelegations(input: {
    parentThreadId: string;
    mode: "all" | "any";
    minCompleted?: number;
    timeoutMs: number;
    runIds?: string[];
    abortSignal?: AbortSignal;
  }): Promise<{ status: "completed" | "timeout"; completedCount: number; runningCount: number }> {
    const runIds = input.runIds ? new Set(input.runIds) : undefined;
    const selectedRuns = () => this.listByParentSession(input.parentThreadId)
      .filter((run) => !runIds || runIds.has(run.runId));
    const runs = selectedRuns();
    const running = runs.filter((run) => !this.terminalStatuses.has(run.status));
    const completedCount = runs.length - running.length;

    if (running.length === 0) {
      return { status: "completed", completedCount, runningCount: 0 };
    }

    const target = input.mode === "any"
      ? Math.min(Math.max(input.minCompleted ?? 1, 1), runs.length)
      : runs.length;

    if (completedCount >= target) {
      return { status: "completed", completedCount, runningCount: running.length };
    }

    if (input.abortSignal?.aborted) throw new Error("aborted");
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (status: "completed" | "timeout", error?: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        input.abortSignal?.removeEventListener("abort", abort);
        if (error) {
          reject(error);
          return;
        }
        const current = selectedRuns();
        const currentRunning = current.filter((run) => !this.terminalStatuses.has(run.status)).length;
        resolve({
          status,
          completedCount: current.length - currentRunning,
          runningCount: currentRunning
        });
      };
      const abort = () => finish("timeout", new Error("aborted"));

      const check = () => {
        const current = selectedRuns();
        const done = current.filter((run) => this.terminalStatuses.has(run.status)).length;
        if (done >= target) finish("completed");
      };

      for (const run of running) {
        const completion = this.getDelegationCompletion(run.runId);
        if (completion) completion.then(check);
      }

      input.abortSignal?.addEventListener("abort", abort, { once: true });
      if (input.abortSignal?.aborted) {
        abort();
        return;
      }
      timer = setTimeout(() => finish("timeout"), input.timeoutMs);
      // 不 unref：unref 在事件循环空闲时（纯 timeout 用例 / 父 wait 时短暂无其他活动）会让 timer 永不 fire，
      // 使超时语义失效。生产 sidecar 退出走 stopAllAgentRuntimeSessions 中止 runtime，wait 调用随父终止结束，
      // pending timer 由进程退出回收。
    });
  }
}

let singleton: SubagentRunRegistry | null = null;

export function getSubagentRunRegistry(): SubagentRunRegistry {
  if (!singleton) {
    singleton = new SubagentRunRegistry();
  }
  return singleton;
}

export function resetSubagentRunRegistryForTest(): void {
  singleton = null;
}

// ─── Run store persistence (migrated from subagent-run-store.ts) ───

const storeLog = createLogger("subagent-run-store");
// 必须与 SubagentWorkStore 的 subagent-runs.json 分文件：两者 schema 不兼容
// （v1 runs-only vs v2 sessions/tasks/feedback），共写同一路径会互相覆盖。
const STORE_FILE = "delegation-runs.json";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeAtomic(path: string, payload: string): void {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

function normalizeRun(raw: unknown): SubagentRun | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const runId = typeof record.runId === "string" ? record.runId.trim() : "";
  const parentThreadId = typeof record.parentThreadId === "string" ? record.parentThreadId.trim() : "";
  const parentRunId = typeof record.parentRunId === "string" ? record.parentRunId.trim() : undefined;
  const rootThreadId = typeof record.rootThreadId === "string"
    ? record.rootThreadId.trim()
    : parentThreadId;
  const depth = typeof record.depth === "number" && Number.isFinite(record.depth)
    ? Math.max(0, Math.floor(record.depth))
    : 1;
  const childThreadId = typeof record.childThreadId === "string" ? record.childThreadId.trim() : "";
  const task = typeof record.task === "string" ? record.task : "";
  const status = typeof record.status === "string" ? record.status : "accepted";
  const cleanup = record.cleanup === "delete" ? "delete" : "keep";
  const createdAt = typeof record.createdAt === "number" ? record.createdAt : Date.now();
  const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : createdAt;

  if (!runId || !parentThreadId || !childThreadId || !task) return null;

  const outcomeRaw = record.outcome;
  const outcome = outcomeRaw && typeof outcomeRaw === "object"
    ? {
      output: typeof (outcomeRaw as Record<string, unknown>).output === "string"
        ? (outcomeRaw as Record<string, unknown>).output as string
        : undefined,
      error: typeof (outcomeRaw as Record<string, unknown>).error === "string"
        ? (outcomeRaw as Record<string, unknown>).error as string
        : undefined,
      errorCode: typeof (outcomeRaw as Record<string, unknown>).errorCode === "string"
        ? (outcomeRaw as Record<string, unknown>).errorCode as string
        : undefined,
      usageEvents: typeof (outcomeRaw as Record<string, unknown>).usageEvents === "number"
        ? (outcomeRaw as Record<string, unknown>).usageEvents as number
        : undefined
    }
    : undefined;

  return {
    runId,
    parentThreadId,
    ...(Array.isArray(record.runtimeRunIds)
      ? { runtimeRunIds: record.runtimeRunIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0) }
      : {}),
    parentRunId: parentRunId && parentRunId.length > 0 ? parentRunId : undefined,
    rootThreadId: rootThreadId || parentThreadId,
    depth,
    childThreadId,
    deliveryThreadId: typeof record.deliveryThreadId === "string" ? record.deliveryThreadId : undefined,
    threadRequested: record.threadRequested === true,
    threadBound: record.threadBound === true,
    background: record.background === true,
    label: typeof record.label === "string" ? record.label : undefined,
    task,
    status: status as SubagentRun["status"],
    cleanup,
    parentToolUseId: typeof record.parentToolUseId === "string" ? record.parentToolUseId : undefined,
    requestedAgentId: typeof record.requestedAgentId === "string" ? record.requestedAgentId : undefined,
    resolvedAgentId: typeof record.resolvedAgentId === "string" ? record.resolvedAgentId : undefined,
    modelRef: typeof record.modelRef === "string" ? record.modelRef : undefined,
    channelId: typeof record.channelId === "string" ? record.channelId : undefined,
    modelId: typeof record.modelId === "string" ? record.modelId : undefined,
    announceStatus: (
      record.announceStatus === "pending"
      || record.announceStatus === "delivered"
      || record.announceStatus === "failed"
    ) ? record.announceStatus : undefined,
    announceAttempts: typeof record.announceAttempts === "number" ? record.announceAttempts : undefined,
    announceLastError: typeof record.announceLastError === "string" ? record.announceLastError : undefined,
    announceDeliveredAt: typeof record.announceDeliveredAt === "number" ? record.announceDeliveredAt : undefined,
    createdAt,
    updatedAt,
    startedAt: typeof record.startedAt === "number" ? record.startedAt : undefined,
    endedAt: typeof record.endedAt === "number" ? record.endedAt : undefined,
    outcome
  };
}

export function getSubagentRunStorePath(): string {
  return `${getAgentConfigDir()}/${STORE_FILE}`;
}

function readSubagentRunStore(): SubagentRunStoreSchema {
  const path = getSubagentRunStorePath();
  if (!existsSync(path)) {
    return {
      version: SUBAGENT_RUN_STORE_VERSION,
      runs: []
    };
  }

  let parsed: unknown;
  try {
    parsed = readJson(path);
  } catch (error) {
    return quarantineInvalidStore(
      path,
      error instanceof Error ? error.message : String(error)
    );
  }
  if (!parsed || typeof parsed !== "object") {
    return quarantineInvalidStore(path, "根对象不是 JSON object");
  }

  const record = parsed as Record<string, unknown>;
  if (record.version !== SUBAGENT_RUN_STORE_VERSION) {
    return quarantineInvalidStore(path, `不支持的版本: ${String(record.version)}`);
  }
  if (!Array.isArray(record.runs)) {
    return quarantineInvalidStore(path, "runs 不是数组");
  }
  const runs = record.runs.map(normalizeRun).filter((item): item is SubagentRun => !!item);

  return {
    version: SUBAGENT_RUN_STORE_VERSION,
    runs
  };
}

function quarantineInvalidStore(path: string, reason: string): SubagentRunStoreSchema {
  const backupPath = backupCorruptFile(path);
  if (!backupPath) {
    throw new Error(`subagent run store 损坏且备份失败: ${reason}`);
  }
  storeLog.warn("subagent run store 损坏，已检疫后重建", {
    path,
    backupPath,
    reason
  });
  return {
    version: SUBAGENT_RUN_STORE_VERSION,
    runs: []
  };
}

function writeSubagentRunStore(schema: SubagentRunStoreSchema): void {
  const path = getSubagentRunStorePath();
  const payload = JSON.stringify(schema, null, 2);
  writeAtomic(path, payload);
}
