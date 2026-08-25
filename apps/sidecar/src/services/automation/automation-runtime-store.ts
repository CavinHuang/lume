import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import type { AutomationRunStatus } from "@lume/shared";
import { getConfigDir } from "../infra/config-paths";

export interface AutomationRuntimeState {
  version: 1;
  jobId: string;
  status: AutomationRunStatus | "idle";
  lease?: {
    id: string;
    ownerId: string;
    scheduledAt: number;
    runId: string;
    heartbeatAt: number;
  };
  threadId?: string;
  pendingScheduledAt?: number;
  message?: string;
  updatedAt: number;
}

export interface AutomationLease {
  jobId: string;
  leaseId: string;
  runId: string;
  scheduledAt: number;
}

const OWNER_ID = `${process.pid}:${randomUUID()}`;
const STALE_LEASE_MS = 30_000;

export function tryAcquireAutomationLease(input: {
  jobId: string;
  scheduledAt: number;
  runId: string;
}): AutomationLease | null {
  const dir = runtimeDir(input.jobId);
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, "lease.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
      const lease: AutomationLease = {
        jobId: input.jobId,
        leaseId: randomUUID(),
        runId: input.runId,
        scheduledAt: input.scheduledAt
      };
      try {
        writeState({
          version: 1,
          jobId: input.jobId,
          status: "running",
          lease: {
            id: lease.leaseId,
            ownerId: OWNER_ID,
            scheduledAt: input.scheduledAt,
            runId: input.runId,
            heartbeatAt: Date.now()
          },
          updatedAt: Date.now()
        });
      } catch (error) {
        // lock 已建而 state 写失败（盘满）：不回滚则孤儿 lock 使该 job 永久 skipped 且重启不自愈
        // （#615 review round5）
        try {
          rmSync(lockPath, { force: true });
        } catch {
          /* 无能为力，只能放弃本周期 */
        }
        throw error;
      }
      return lease;
    } catch {
      const state = readAutomationRuntimeState(input.jobId);
      if (!isStaleRunningLease(state)) return null;
      try {
        writeState({
          ...state!,
          status: "interrupted",
          message: "Sidecar 重启或 lease 心跳超时；未知副作用不会自动重放。",
          lease: undefined,
          updatedAt: Date.now()
        });
      } catch {
        // 盘满下自愈写失败：放弃本周期，不得向外抛（fire-and-forget 调用链）
        try { rmSync(lockPath, { force: true }); } catch { /* ignore */ }
        return null;
      }
      try {
        rmSync(lockPath, { force: true });
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function heartbeatAutomationLease(lease: AutomationLease, threadId?: string): boolean {
  const state = readAutomationRuntimeState(lease.jobId);
  if (!state?.lease || state.lease.id !== lease.leaseId) return false;
  writeState({
    ...state,
    ...(threadId ? { threadId } : {}),
    lease: { ...state.lease, heartbeatAt: Date.now() },
    updatedAt: Date.now()
  });
  return true;
}

export function finishAutomationLease(
  lease: AutomationLease,
  input: {
    status: AutomationRunStatus;
    threadId?: string;
    message?: string;
    keepForInteraction?: boolean;
  }
): void {
  const state = readAutomationRuntimeState(lease.jobId);
  if (!state?.lease || state.lease.id !== lease.leaseId) return;
  writeState({
    ...state,
    status: input.status,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.message ? { message: input.message } : {}),
    lease: input.keepForInteraction ? state.lease : undefined,
    updatedAt: Date.now()
  });
  if (!input.keepForInteraction) {
    rmSync(join(runtimeDir(lease.jobId), "lease.lock"), { force: true });
  }
}

export function mergeLatestAutomationTrigger(jobId: string, scheduledAt: number): void {
  const state = readAutomationRuntimeState(jobId) ?? {
    version: 1 as const,
    jobId,
    status: "queued" as const,
    updatedAt: Date.now()
  };
  writeState({
    ...state,
    pendingScheduledAt: Math.max(state.pendingScheduledAt ?? 0, scheduledAt),
    updatedAt: Date.now()
  });
}

export function consumeLatestAutomationTrigger(jobId: string): number | undefined {
  const state = readAutomationRuntimeState(jobId);
  if (!state?.pendingScheduledAt) return undefined;
  const scheduledAt = state.pendingScheduledAt;
  writeState({
    ...state,
    pendingScheduledAt: undefined,
    updatedAt: Date.now()
  });
  return scheduledAt;
}

export function readAutomationRuntimeState(jobId: string): AutomationRuntimeState | null {
  const path = statePath(jobId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as AutomationRuntimeState;
    return parsed?.version === 1 && parsed.jobId === jobId ? parsed : null;
  } catch {
    return null;
  }
}

export function recoverAutomationRuntimeStates(): AutomationRuntimeState[] {
  const root = runtimeRoot();
  if (!existsSync(root)) return [];
  const states: AutomationRuntimeState[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const state = readAutomationRuntimeState(entry.name);
    if (!state) continue;
    if (isStaleRunningLease(state)) {
      const interrupted: AutomationRuntimeState = {
        ...state,
        status: "interrupted",
        message: "Sidecar 重启后未找到可恢复的活动执行；未知副作用不会自动重放。",
        lease: undefined,
        updatedAt: Date.now()
      };
      writeState(interrupted);
      rmSync(join(runtimeDir(state.jobId), "lease.lock"), { force: true });
      states.push(interrupted);
    } else if (isStaleWaitingInteraction(state)) {
      // #587:waiting_* 无状态迁移入口且重启不恢复——live resolver 已随重启消亡,
      // 心跳陈旧的 waiting 态若不清掉,任务永远显示"已启用"却再不会被调度
      const interrupted: AutomationRuntimeState = {
        ...state,
        status: "interrupted",
        message: "Sidecar 重启后等待中的交互已失效；请在对应线程中查看进度或手动重跑。",
        lease: undefined,
        updatedAt: Date.now()
      };
      writeState(interrupted);
      rmSync(join(runtimeDir(state.jobId), "lease.lock"), { force: true });
      states.push(interrupted);
    } else {
      states.push(state);
    }
  }
  return states;
}

function isStaleRunningLease(state: AutomationRuntimeState | null): boolean {
  return Boolean(
    state?.status === "running"
    && state.lease
    && Date.now() - state.lease.heartbeatAt > STALE_LEASE_MS
  );
}

function isStaleWaitingInteraction(state: AutomationRuntimeState | null): boolean {
  return Boolean(
    (state?.status === "waiting_for_user" || state?.status === "waiting_for_approval")
    && state.lease
    && Date.now() - state.lease.heartbeatAt > STALE_LEASE_MS
  );
}

function runtimeRoot(): string {
  return join(getConfigDir(), "automation", "runtime");
}

function runtimeDir(jobId: string): string {
  return join(runtimeRoot(), jobId);
}

function statePath(jobId: string): string {
  return join(runtimeDir(jobId), "state.json");
}

function writeState(state: AutomationRuntimeState): void {
  const dir = runtimeDir(state.jobId);
  mkdirSync(dir, { recursive: true });
  const path = statePath(state.jobId);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), "utf8");
  renameSync(temporary, path);
}
