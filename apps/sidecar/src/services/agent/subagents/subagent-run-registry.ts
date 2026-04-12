import { createLogger } from "../../infra/logger";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { getAgentConfigDir } from "../../infra/config-paths";
import {
  SUBAGENT_RUN_STORE_VERSION,
  type CreateSubagentRunInput,
  type SubagentRun,
  type SubagentRunStatus,
  type SubagentRunStoreSchema,
  type UpdateSubagentRunInput
} from "./subagent-run.types";

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

function cloneRun(run: SubagentRun): SubagentRun {
  return {
    ...run,
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

class SubagentRunRegistry {
  private runs = new Map<string, SubagentRun>();
  private loadDone = false;
  private readonly terminalStatuses = new Set(["completed", "errored", "aborted", "timed_out", "canceled"]);

  private ensureLoaded(): void {
    if (this.loadDone) return;
    const store = readSubagentRunStore();
    for (const run of store.runs) {
      this.runs.set(run.runId, run);
    }
    this.loadDone = true;
  }

  private persist(): void {
    this.ensureLoaded();
    const runs = Array.from(this.runs.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_PERSISTED_RUNS)
      .reverse();
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

  listDescendants(runId: string): SubagentRun[] {
    this.ensureLoaded();
    const childrenByParent = new Map<string, SubagentRun[]>();
    for (const run of this.runs.values()) {
      if (!run.parentRunId) continue;
      const bucket = childrenByParent.get(run.parentRunId) ?? [];
      bucket.push(run);
      childrenByParent.set(run.parentRunId, bucket);
    }
    const queue = [runId];
    const visited = new Set<string>();
    const descendants: SubagentRun[] = [];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      const children = childrenByParent.get(current) ?? [];
      for (const child of children) {
        descendants.push(cloneRun(child));
        queue.push(child.runId);
      }
    }
    return descendants.sort((a, b) => a.createdAt - b.createdAt);
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
    this.persist();
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
const STORE_FILE = "subagent-runs.json";

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
    parentRunId: parentRunId && parentRunId.length > 0 ? parentRunId : undefined,
    rootThreadId: rootThreadId || parentThreadId,
    depth,
    childThreadId,
    deliveryThreadId: typeof record.deliveryThreadId === "string" ? record.deliveryThreadId : undefined,
    threadRequested: record.threadRequested === true,
    threadBound: record.threadBound === true,
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

  try {
    const parsed = readJson(path);
    if (!parsed || typeof parsed !== "object") {
      return {
        version: SUBAGENT_RUN_STORE_VERSION,
        runs: []
      };
    }

    const record = parsed as Record<string, unknown>;
    const runs = Array.isArray(record.runs)
      ? record.runs.map(normalizeRun).filter((item): item is SubagentRun => !!item)
      : [];

    return {
      version: SUBAGENT_RUN_STORE_VERSION,
      runs
    };
  } catch (error) {
    storeLog.warn("读取 subagent run store 失败，使用空数据", {
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      version: SUBAGENT_RUN_STORE_VERSION,
      runs: []
    };
  }
}

function writeSubagentRunStore(schema: SubagentRunStoreSchema): void {
  const path = getSubagentRunStorePath();
  const payload = JSON.stringify(schema, null, 2);
  writeAtomic(path, payload);
}

