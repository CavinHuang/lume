import { createLogger } from "../../logger";
import {
  readSubagentRunStore,
  writeSubagentRunStore
} from "./subagent-run-store";
import { subagentLogFields } from "./subagent-observability";
import {
  SUBAGENT_RUN_STORE_VERSION,
  type CreateSubagentRunInput,
  type SubagentRun,
  type SubagentRunStatus,
  type UpdateSubagentRunInput
} from "./subagent-run.types";

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
      parentSessionId: input.parentSessionId,
      parentRunId: input.parentRunId,
      rootSessionId: input.rootSessionId ?? input.parentSessionId,
      depth: typeof input.depth === "number" ? Math.max(0, Math.floor(input.depth)) : 1,
      childSessionId: input.childSessionId,
      deliverySessionId: input.deliverySessionId,
      threadRequested: input.threadRequested === true,
      threadBound: input.threadBound === true,
      label: input.label,
      task: input.task,
      status: input.status ?? "accepted",
      cleanup: input.cleanup,
      parentToolUseId: input.parentToolUseId,
      requestedAgentId: input.requestedAgentId,
      resolvedAgentId: input.resolvedAgentId,
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

  listByParentSession(parentSessionId: string): SubagentRun[] {
    this.ensureLoaded();
    return Array.from(this.runs.values())
      .filter((run) => run.parentSessionId === parentSessionId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(cloneRun);
  }

  listByRootSession(rootSessionId: string): SubagentRun[] {
    this.ensureLoaded();
    return Array.from(this.runs.values())
      .filter((run) => run.rootSessionId === rootSessionId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(cloneRun);
  }

  listControlledBySession(ownerSessionId: string): SubagentRun[] {
    this.ensureLoaded();
    const merged = new Map<string, SubagentRun>();
    for (const run of this.runs.values()) {
      if (run.parentSessionId === ownerSessionId || run.rootSessionId === ownerSessionId) {
        merged.set(run.runId, cloneRun(run));
      }
    }
    return Array.from(merged.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  getLatestByChildSession(childSessionId: string): SubagentRun | null {
    this.ensureLoaded();
    const matched = Array.from(this.runs.values())
      .filter((run) => run.childSessionId === childSessionId)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    return matched ? cloneRun(matched) : null;
  }

  countActiveByParentSession(parentSessionId: string): number {
    this.ensureLoaded();
    return Array.from(this.runs.values()).filter((run) => (
      run.parentSessionId === parentSessionId && !this.terminalStatuses.has(run.status)
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
