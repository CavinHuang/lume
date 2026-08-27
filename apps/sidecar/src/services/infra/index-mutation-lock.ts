import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

const DEFAULT_STALE_MS = 30_000;
// fail-fast 而非长忙等：忙等会冻结整个 sidecar 主线程（RPC/agent 流全部停摆），
// 且跨进程争用只在接管重叠的极窄窗口出现；超时错误作为可重试错误上抛，
// 由用户驱动操作的重试或 workdir-resolver 的 catch 降级兜底（#526）
const DEFAULT_TIMEOUT_MS = 300;
const localLocks = new Set<string>();
const waitSignal = new Int32Array(new SharedArrayBuffer(4));

interface LockPayload {
  pid: number;
  token: string;
  createdAt: number;
}

// 模块级 SharedArrayBuffer 单例 + 分帧；供各 sync 锁实现复用（#526 补充发现4）
export function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      Atomics.wait(waitSignal, 0, 0, Math.min(50, end - Date.now()));
    } catch {
      // 运行时不允许主线程阻塞时退化为不等待
      return;
    }
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

// 判定仅基于 pid 存活（process.kill 0 信号），未校验进程身份——Windows 上 PID 复用快，
// 存在把复用者误判为原持有者的低概率窗口（#526 P3，已知局限）
export function isProcessAlive(pid: number | undefined): boolean | undefined {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 表示目标进程存在但无权发信号——仍视为存活
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM" ? true : false;
  }
}

function isStale(lockPath: string, staleMs: number): { stale: boolean; payload: LockPayload | null } {
  try {
    const stat = statSync(lockPath);
    const payload = readLockPayload(lockPath);
    // 0 字节 = 持有者死于 wx 创建与首次原子写之间的极窄窗口，无幸存者语义可立即接管；
    // 非空烂数据保守走 mtime 通道（writeFileSync 单次写，撕裂基本不存在）（#526 P1）
    if (payload === null) return { stale: stat.size === 0, payload: null };
    // mtime 过期不能单独判死：合法长持锁（如 workdir 迁移秒级 cpSync）会被
    // 另一进程偷走造成双持锁；必须以持有者 pid 存活为准（#526）
    if (Date.now() - stat.mtimeMs > staleMs) {
      const alive = isProcessAlive(payload.pid);
      if (alive === true) return { stale: false, payload };
      return { stale: true, payload };
    }
    if (isProcessAlive(payload.pid) === false) return { stale: true, payload };
    return { stale: false, payload };
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
      // 创建与写入间隙锁可能被竞争方按 stale 清走——写后回读校验身份，
      // 防止带着指向孤儿文件的 fd 假持锁（#526 P1 配套）
      if (readLockPayload(lockPath)?.token !== payload.token) continue;
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
  // 全部调用方回调均同步执行、无 yield 点，同线程能撞上 in-flight 锁只有嵌套重入
  // 一种可能——那是调用方缺陷，立刻炸出而非忙等冻结主线程（#526）
  if (localLocks.has(lockPath)) {
    throw new Error(`索引锁同步重入（同线程嵌套获取同一路径锁）: ${lockPath}`);
  }
  localLocks.add(lockPath);

  try {
    return withCrossProcessLock(lockPath, fn, options);
  } finally {
    localLocks.delete(lockPath);
  }
}
