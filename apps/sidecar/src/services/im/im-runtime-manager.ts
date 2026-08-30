import type { ImAccount, ImAccountUpdateInput } from "@lume/shared";
import {
  getImRuntimeAccount,
  listImAccounts,
  updateImAccount,
  type ImRuntimeAccount
} from "./im-config-manager";
import { getImProvider, type ImWorker } from "./provider-registry";
import { imInboundPipeline } from "./im-inbound-pipeline";
import { createLogger } from "../infra/logger";

const log = createLogger("im-runtime");

let providersLoaded = false;
/**
 * 副作用 import：模块加载即把各 provider 注册进 provider-registry。
 * 延迟到首次启动 IM 账户才加载，避免 sidecar 冷启动期同步拉入 IM SDK
 * （dingtalk-stream/飞书/企微）拖慢启动——曾使 reading-entrypoint 测试 5s 超时。
 */
async function ensureProvidersLoaded(): Promise<void> {
  if (providersLoaded) return;
  await import("./weixin/weixin-provider");
  await import("./dingtalk/dingtalk-provider");
  await import("./feishu/feishu-provider");
  await import("./wecom/wecom-provider");
  providersLoaded = true;
}

export interface ImRuntimeManager {
  startEnabledAccounts(): Promise<void>;
  startAccount(accountId: string): Promise<void>;
  stopAccount(accountId: string): void;
  stopAll(): void;
  getRunningAccountIds(): string[];
  /** #598：error 态账号自愈扫描一轮（enabled+error，指数退避）。返回本轮实际尝试的账号 id。 */
  runRecoveryTick(now?: number): Promise<string[]>;
  /** #598：按 interval 周期驱动 runRecoveryTick。 */
  startAutoRecovery(options?: { intervalMs?: number; baseDelayMs?: number; maxDelayMs?: number }): void;
  stopAutoRecovery(): void;
}

export interface CreateImRuntimeManagerInput {
  listAccounts?: () => ImAccount[];
  getRuntimeAccount?: (id: string) => ImRuntimeAccount;
  updateAccount?: (id: string, input: ImAccountUpdateInput) => void | Promise<void>;
  createWorker?: (account: ImRuntimeAccount) => ImWorker;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createImRuntimeManager(input: CreateImRuntimeManagerInput = {}): ImRuntimeManager {
  const workers = new Map<string, ImWorker>();
  const pendingStarts = new Map<string, { promise: Promise<void>; lifecycleVersion: number }>();
  const pendingStops = new Map<string, Promise<void>>();
  const lifecycleVersions = new Map<string, number>();
  const listAccountsFn = input.listAccounts ?? listImAccounts;
  const getRuntimeAccountFn = input.getRuntimeAccount ?? getImRuntimeAccount;
  const updateAccountFn = input.updateAccount ?? updateImAccount;
  const createWorkerFn = input.createWorker ?? ((account: ImRuntimeAccount) => {
    const def = getImProvider(account.provider);
    return def.createWorker(account, {
      // 入站统一走整形管线（防抖合并 + 并发协调）。enqueue 的 Promise 在批量路由
      // 落定后 settle：微信长轮询 worker await 它保持「失败不推 cursor」的重投语义，
      // WS 三渠道 worker void 掉但必须自带 .catch（见各 worker 调用点）。
      routeMessage: (m) => imInboundPipeline.enqueue(m),
      updateAccount: (id, input) => {
        // utilityProcess 下 unhandledRejection=throw，回写失败不能崩进程（如账号已被删除）
        void Promise.resolve(updateAccountFn(id, input)).catch((error: unknown) => {
          log.warn("worker 状态回写失败", { id, error: errorMessage(error) });
        });
      },
    });
  });

  // #598：error 态账号指数退避状态（attempts 从 1 起计；nextAt 为最早可重试时刻）
  const recoveryBackoff = new Map<string, { attempts: number; nextAt: number }>();
  let recoveryOptions = { intervalMs: 30_000, baseDelayMs: 30_000, maxDelayMs: 30 * 60_000 };
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;

  return {
    async startEnabledAccounts() {
      await ensureProvidersLoaded();
      for (const account of listAccountsFn()) {
        if (!account.enabled) continue;
        try {
          await this.startAccount(account.id);
        } catch {
          // startAccount records the per-account failure; keep siblings alive.
        }
      }
    },

    async startAccount(accountId: string) {
      const lifecycleVersion = lifecycleVersions.get(accountId) ?? 0;
      const pendingStop = pendingStops.get(accountId);
      if (pendingStop) {
        await pendingStop;
        if ((lifecycleVersions.get(accountId) ?? 0) !== lifecycleVersion) return;
      }
      const pending = pendingStarts.get(accountId);
      if (pending?.lifecycleVersion === lifecycleVersion) return pending.promise;
      if (pending) {
        try { await pending.promise; } catch { /* a fresh start may recover from the previous failure */ }
        return this.startAccount(accountId);
      }
      let startPromise!: Promise<void>;
      startPromise = (async () => {
        await ensureProvidersLoaded();
        if ((lifecycleVersions.get(accountId) ?? 0) !== lifecycleVersion) return;
        const existingWorker = workers.get(accountId);
        if (existingWorker?.isRunning()) return;
        if (existingWorker) {
          workers.delete(accountId);
        }
        await updateAccountFn(accountId, {
          status: "starting",
          lastStartedAt: Date.now(),
          lastError: null
        });
        if ((lifecycleVersions.get(accountId) ?? 0) !== lifecycleVersion) {
          await recordStopped(accountId, updateAccountFn);
          return;
        }
        let worker: ImWorker | undefined;
        try {
          const account = getRuntimeAccountFn(accountId);
          worker = createWorkerFn(account);
          worker.start();
          workers.set(accountId, worker);
          await updateAccountFn(accountId, {
            status: "running",
            lastError: null
          });
          if ((lifecycleVersions.get(accountId) ?? 0) !== lifecycleVersion) {
            if (workers.get(accountId) === worker) stopWorker(accountId, worker, workers);
            await recordStopped(accountId, updateAccountFn);
          }
        } catch (error) {
          const cancelled = (lifecycleVersions.get(accountId) ?? 0) !== lifecycleVersion;
          if (worker && (workers.get(accountId) === worker || !cancelled)) {
            stopWorker(accountId, worker, workers);
          }
          if (cancelled) {
            await recordStopped(accountId, updateAccountFn);
            return;
          }
          try {
            await updateAccountFn(accountId, {
              status: "error",
              lastError: errorMessage(error)
            });
          } catch (updateError) {
            log.warn("启动失败状态回写失败", { accountId, error: errorMessage(updateError) });
          }
          throw error;
        }
      })().finally(() => {
        if (pendingStarts.get(accountId)?.promise === startPromise) pendingStarts.delete(accountId);
      });
      pendingStarts.set(accountId, { promise: startPromise, lifecycleVersion });
      return startPromise;
    },

    stopAccount(accountId: string) {
      recoveryBackoff.delete(accountId);
      lifecycleVersions.set(accountId, (lifecycleVersions.get(accountId) ?? 0) + 1);
      const worker = workers.get(accountId);
      if (worker) stopWorker(accountId, worker, workers);
      const stopped = recordStopped(accountId, updateAccountFn).finally(() => {
        if (pendingStops.get(accountId) === stopped) pendingStops.delete(accountId);
      });
      pendingStops.set(accountId, stopped);
    },

    stopAll() {
      this.stopAutoRecovery();
      recoveryBackoff.clear();
      for (const accountId of new Set([...workers.keys(), ...pendingStarts.keys()])) {
        this.stopAccount(accountId);
      }
    },

    getRunningAccountIds() {
      return Array.from(workers.keys());
    },

    async runRecoveryTick(now = Date.now()) {
      const { baseDelayMs, maxDelayMs } = recoveryOptions;
      const candidates = listAccountsFn().filter((account) => account.enabled && account.status === "error");
      const attempted: string[] = [];
      const restarts: Array<Promise<void>> = [];
      for (const account of candidates) {
        const state = recoveryBackoff.get(account.id);
        if (state && now < state.nextAt) continue;
        attempted.push(account.id);
        recoveryBackoff.set(account.id, { attempts: (state?.attempts ?? 0) + 1, nextAt: Number.MAX_SAFE_INTEGER });
        restarts.push(
          this.startAccount(account.id)
            .then(() => {
              recoveryBackoff.delete(account.id);
            })
            .catch(() => {
              const attempts = recoveryBackoff.get(account.id)?.attempts ?? 1;
              recoveryBackoff.set(account.id, {
                attempts,
                nextAt: now + Math.min(baseDelayMs * 2 ** (attempts - 1), maxDelayMs)
              });
            })
        );
      }
      // 等本轮重启尘埃落定再返回：backoff 状态已定，interval 驱动与测试都可确定
      await Promise.allSettled(restarts);
      return attempted;
    },

    startAutoRecovery(options) {
      recoveryOptions = { ...recoveryOptions, ...options };
      this.stopAutoRecovery();
      recoveryTimer = setInterval(() => {
        void this.runRecoveryTick().catch((error: unknown) => {
          log.warn("error 账号自愈扫描失败", { error: errorMessage(error) });
        });
      }, recoveryOptions.intervalMs);
      recoveryTimer.unref?.();
    },

    stopAutoRecovery() {
      if (recoveryTimer) {
        clearInterval(recoveryTimer);
        recoveryTimer = undefined;
      }
    }
  };
}

function stopWorker(accountId: string, worker: ImWorker, workers: Map<string, ImWorker>): void {
  try {
    worker.stop();
  } catch (error) {
    log.warn("停止 worker 失败", { accountId, error: errorMessage(error) });
  } finally {
    if (workers.get(accountId) === worker) workers.delete(accountId);
  }
}

async function recordStopped(
  accountId: string,
  updateAccount: (id: string, input: ImAccountUpdateInput) => unknown | Promise<unknown>
): Promise<void> {
  try {
    await updateAccount(accountId, {
      status: "stopped",
      lastStoppedAt: Date.now()
    });
  } catch (error) {
    // stopAll 触发时账号可能已被删除（updateImAccount throw），floating reject 会崩进程
    log.warn("停止状态回写失败", { accountId, error: errorMessage(error) });
  }
}

export const imRuntimeManager = createImRuntimeManager();
