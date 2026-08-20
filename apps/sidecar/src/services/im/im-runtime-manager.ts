import type { ImAccount, ImAccountUpdateInput } from "@lume/shared";
import {
  getImRuntimeAccount,
  listImAccounts,
  updateImAccount,
  type ImRuntimeAccount
} from "./im-config-manager";
import { getImProvider, type ImWorker } from "./provider-registry";
import { routeInboundImMessage } from "./im-message-router";
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
  const listAccountsFn = input.listAccounts ?? listImAccounts;
  const getRuntimeAccountFn = input.getRuntimeAccount ?? getImRuntimeAccount;
  const updateAccountFn = input.updateAccount ?? updateImAccount;
  const createWorkerFn = input.createWorker ?? ((account: ImRuntimeAccount) => {
    const def = getImProvider(account.provider);
    return def.createWorker(account, {
      // routeInboundImMessage 返回 Promise<{threadId}>,updateAccountFn 可能返回 ImAccount;
      // deps 契约为 Promise<void>(worker 不消费返回值)。async 包装保留 await 顺序语义
      // (微信长轮询 worker await routeMessage 确保串行),钉钉事件 worker 则 void 丢弃。
      routeMessage: async (m) => {
        await routeInboundImMessage(m);
      },
      updateAccount: (id, input) => {
        // utilityProcess 下 unhandledRejection=throw，回写失败不能崩进程（如账号已被删除）
        void Promise.resolve(updateAccountFn(id, input)).catch((error: unknown) => {
          log.warn("worker 状态回写失败", { id, error: errorMessage(error) });
        });
      },
    });
  });

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
      await ensureProvidersLoaded();
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
      try {
        const account = getRuntimeAccountFn(accountId);
        const worker = createWorkerFn(account);
        worker.start();
        workers.set(accountId, worker);
        await updateAccountFn(accountId, {
          status: "running",
          lastError: null
        });
      } catch (error) {
        await updateAccountFn(accountId, {
          status: "error",
          lastError: errorMessage(error)
        });
        throw error;
      }
    },

    stopAccount(accountId: string) {
      const worker = workers.get(accountId);
      if (!worker) return;
      worker.stop();
      workers.delete(accountId);
      void Promise.resolve(updateAccountFn(accountId, {
        status: "stopped",
        lastStoppedAt: Date.now()
      })).catch((error: unknown) => {
        // stopAll 触发时账号可能已被删除（updateImAccount throw），floating reject 会崩进程
        log.warn("停止状态回写失败", { accountId, error: errorMessage(error) });
      });
    },

    stopAll() {
      for (const accountId of Array.from(workers.keys())) {
        this.stopAccount(accountId);
      }
    },

    getRunningAccountIds() {
      return Array.from(workers.keys());
    }
  };
}

export const imRuntimeManager = createImRuntimeManager();
