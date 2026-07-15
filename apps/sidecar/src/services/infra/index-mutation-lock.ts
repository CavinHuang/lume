import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const localLocks = new Set<string>();

interface LockPayload {
  pid: number;
  token: string;
  createdAt: number;
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(50, end - Date.now()));
  }
}

function readLockPayload(lockPath: string): LockPayload | null {
  try {
    const payload = JSON.parse(readFileSync(lockPath, "utf-8")) as Partial<LockPayload>;
    if (
      typeof payload.pid === "number"
      && typeof payload.token === "string"
      && typeof payload.createdAt === "number"
    ) {
      return { pid: payload.pid, token: payload.token, createdAt: payload.createdAt };
    }
  } catch {
    // Broken locks are stale candidates, but still removed with token recheck below.
  }
  return null;
}

function isStale(lockPath: string, staleMs: number): { stale: boolean; payload: LockPayload | null } {
  try {
    const stat = statSync(lockPath);
    const payload = readLockPayload(lockPath);
    if (Date.now() - stat.mtimeMs > staleMs) return { stale: true, payload };
    const pid = payload?.pid;
    if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return { stale: false, payload };
    try {
      process.kill(pid, 0);
      return { stale: false, payload };
    } catch {
      return { stale: true, payload };
    }
  } catch {
    return { stale: true, payload: null };
  }
}

function tryRemoveStaleLock(lockPath: string, observed: LockPayload | null): boolean {
  const current = readLockPayload(lockPath);
  if (
    observed
    && current
    && (current.token !== observed.token || current.pid !== observed.pid || current.createdAt !== observed.createdAt)
  ) {
    return false;
  }
  try {
    rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

function acquireLock(lockPath: string, timeoutMs: number, staleMs: number): LockPayload {
  const startedAt = Date.now();
  const payload: LockPayload = { pid: process.pid, token: randomUUID(), createdAt: Date.now() };

  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, JSON.stringify(payload), "utf-8");
      } finally {
        closeSync(fd);
      }
      return payload;
    } catch {
      if (existsSync(lockPath)) {
        const staleCheck = isStale(lockPath, staleMs);
        if (staleCheck.stale && tryRemoveStaleLock(lockPath, staleCheck.payload)) {
          continue;
        }
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`获取索引锁超时: ${lockPath}`);
      }
      sleepSync(25);
    }
  }
}

function releaseLock(lockPath: string, payload: LockPayload): void {
  const current = readLockPayload(lockPath);
  if (!current || current.token !== payload.token || current.pid !== payload.pid || current.createdAt !== payload.createdAt) {
    return;
  }
  rmSync(lockPath, { force: true });
}

function withCrossProcessLock<T>(
  lockPath: string,
  fn: () => T,
  options: { timeoutMs?: number; staleMs?: number } = {}
): T {
  mkdirSync(dirname(lockPath), { recursive: true });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const payload = acquireLock(lockPath, timeoutMs, staleMs);

  try {
    return fn();
  } finally {
    releaseLock(lockPath, payload);
  }
}

export function withIndexMutationLock<T>(
  lockPath: string,
  fn: () => T,
  options: { timeoutMs?: number; staleMs?: number } = {}
): T {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  while (localLocks.has(lockPath)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`获取进程内索引锁超时: ${lockPath}`);
    }
    sleepSync(5);
  }
  localLocks.add(lockPath);

  try {
    return withCrossProcessLock(lockPath, fn, options);
  } finally {
    localLocks.delete(lockPath);
  }
}
