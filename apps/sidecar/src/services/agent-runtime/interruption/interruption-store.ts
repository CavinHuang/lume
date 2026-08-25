import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import type { LumeInterruption } from "./interruption";
import { ACTIVE_RUN_STATUSES, type LumeRunState } from "../runtime-core/run-state";
import { createFileBackedLumeRunStateStore } from "../runtime-core/run-state-store";

export interface LumeInterruptionStore {
  upsert(interruption: LumeInterruption): Promise<void>;
  get(interruptionId: string): Promise<LumeInterruption | null>;
  resolve(interruptionId: string, patch: Pick<LumeInterruption, "status" | "resolution">): Promise<void>;
  listByThread(threadId: string): Promise<LumeInterruption[]>;
  listPendingByThread(threadId: string): Promise<LumeInterruption[]>;
  listPending(): Promise<LumeInterruption[]>;
}

function writeTextAtomic(path: string, payload: string): void {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

function readInterruption(path: string): LumeInterruption | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as LumeInterruption;
  } catch {
    return null;
  }
}

class FileBackedLumeInterruptionStore implements LumeInterruptionStore {
  private readonly interruptionsDir: string;

  constructor(sessionDir: string) {
    this.interruptionsDir = join(sessionDir, "interruptions");
    mkdirSync(this.interruptionsDir, { recursive: true });
  }

  async upsert(interruption: LumeInterruption): Promise<void> {
    writeTextAtomic(this.pathFor(interruption.id), JSON.stringify(interruption, null, 2));
    await this.mirrorToRunState(interruption);
  }

  async get(interruptionId: string): Promise<LumeInterruption | null> {
    return readInterruption(this.pathFor(interruptionId));
  }

  async resolve(interruptionId: string, patch: Pick<LumeInterruption, "status" | "resolution">): Promise<void> {
    // 终态守卫与 sync 版一致：get 与 write 之间的 await 间隙里，迟到的 cancel/submit
    // 可并发读到 pending 并 last-writer-wins 翻转终态（round9 安全 review）
    const current = await this.get(interruptionId);
    if (!current || current.status !== "pending") return;
    const now = new Date().toISOString();
    const resolved = {
      ...current,
      ...patch,
      updatedAt: now,
      resolvedAt: now
    };
    writeTextAtomic(this.pathFor(interruptionId), JSON.stringify(resolved, null, 2));
    await this.mirrorToRunState(resolved);
  }

  async listByThread(threadId: string): Promise<LumeInterruption[]> {
    return this.listAll()
      .filter((item) => item.threadId === threadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listPendingByThread(threadId: string): Promise<LumeInterruption[]> {
    return (await this.listByThread(threadId)).filter((item) => item.status === "pending");
  }

  async listPending(): Promise<LumeInterruption[]> {
    return this.listAll().filter((item) => item.status === "pending");
  }

  private listAll(): LumeInterruption[] {
    if (!existsSync(this.interruptionsDir)) return [];
    const result: LumeInterruption[] = [];
    for (const file of readdirSync(this.interruptionsDir)) {
      if (!file.endsWith(".json")) continue;
      const item = readInterruption(join(this.interruptionsDir, file));
      if (item) result.push(item);
    }
    return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private pathFor(interruptionId: string): string {
    return join(this.interruptionsDir, `${safeFileSegment(interruptionId)}.json`);
  }

  private async mirrorToRunState(interruption: LumeInterruption): Promise<void> {
    const runStore = createFileBackedLumeRunStateStore(join(this.interruptionsDir, ".."));
    const runId = interruption.runId
      ?? (await runStore.findActiveByThread(interruption.originThreadId ?? interruption.threadId))?.runId;
    if (!runId) return;
    const state = await runStore.get(runId);
    if (!state) return;
    const pendingInterruptions = interruption.status === "pending"
      ? [
          ...state.pendingInterruptions.filter((item) => item.id !== interruption.id),
          interruption
        ]
      : state.pendingInterruptions.filter((item) => item.id !== interruption.id);
    const hasPendingAsk = pendingInterruptions.some((item) => item.type === "ask_user");
    const nextStatus = pendingInterruptions.length === 0
      ? state.status === "waiting_for_approval" || state.status === "waiting_for_user"
        ? "running"
        : state.status
      : hasPendingAsk
        ? "waiting_for_user"
        : "waiting_for_approval";
    await runStore.update(runId, {
      status: nextStatus,
      pendingInterruptions
    });
  }
}

export function createFileBackedLumeInterruptionStore(sessionDir: string): LumeInterruptionStore {
  return new FileBackedLumeInterruptionStore(sessionDir);
}

export function resolveFileBackedInterruptionSync(
  sessionDir: string,
  interruptionId: string,
  patch: Pick<LumeInterruption, "status" | "resolution">
): boolean {
  const interruptionsDir = join(sessionDir, "interruptions");
  const path = join(interruptionsDir, `${safeFileSegment(interruptionId)}.json`);
  const current = readInterruption(path);
  if (!current) return false;
  // 终态守卫：已 approved/rejected 的记录不得再次翻转（last-writer-wins 会把已取消的
  // 审批改成 approved 并触发 run continuation——round8 正确性 review 竞态另一半）。
  // 写盘失败残留的 pending 记录仍可被正常 resolve，不受影响。
  if (current.status !== "pending") return false;
  const now = new Date().toISOString();
  writeTextAtomic(path, JSON.stringify({
    ...current,
    ...patch,
    updatedAt: now,
    resolvedAt: now
  }, null, 2));
  mirrorToRunStateSync(sessionDir, {
    ...current,
    ...patch,
    updatedAt: now,
    resolvedAt: now
  });
  return true;
}

function mirrorToRunStateSync(sessionDir: string, interruption: LumeInterruption): void {
  const runsDir = join(sessionDir, "runs");
  if (!existsSync(runsDir)) return;
  const runId = interruption.runId ?? findActiveRunIdSync(runsDir, interruption.originThreadId ?? interruption.threadId);
  if (!runId) return;
  const runPath = join(runsDir, `${runId}.json`);
  const state = readJsonFileSync<LumeRunState>(runPath);
  if (!state) return;
  const pendingInterruptions = interruption.status === "pending"
    ? [
        ...state.pendingInterruptions.filter((item) => item.id !== interruption.id),
        interruption
      ]
    : state.pendingInterruptions.filter((item) => item.id !== interruption.id);
  const hasPendingAsk = pendingInterruptions.some((item) => item.type === "ask_user");
  const nextStatus = pendingInterruptions.length === 0
    ? state.status === "waiting_for_approval" || state.status === "waiting_for_user"
      ? "running"
      : state.status
    : hasPendingAsk
      ? "waiting_for_user"
      : "waiting_for_approval";
  writeTextAtomic(runPath, JSON.stringify({
    ...state,
    status: nextStatus,
    pendingInterruptions,
    updatedAt: new Date().toISOString()
  }, null, 2));
}

function findActiveRunIdSync(runsDir: string, threadId: string): string | null {
  for (const file of readdirSync(runsDir)) {
    if (!file.endsWith(".json") || file.endsWith(".items.jsonl")) continue;
    const state = readJsonFileSync<LumeRunState>(join(runsDir, file));
    if (state?.threadId === threadId && ACTIVE_RUN_STATUSES.has(state.status)) {
      return state.runId;
    }
  }
  return null;
}

function readJsonFileSync<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function safeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
