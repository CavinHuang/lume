import type { ImAccount, ImAccountUpdateInput } from "@lume/shared";
import {
  getImRuntimeAccount,
  listImAccounts,
  updateImAccount,
  type ImRuntimeAccount
} from "./im-config-manager";
import {
  createOpenClawWeixinWorker,
  type OpenClawWeixinWorker
} from "./weixin/openclaw-weixin-worker";

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
  createWorker?: (account: ImRuntimeAccount) => OpenClawWeixinWorker;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createImRuntimeManager(input: CreateImRuntimeManagerInput = {}): ImRuntimeManager {
  const workers = new Map<string, OpenClawWeixinWorker>();
  const listAccountsFn = input.listAccounts ?? listImAccounts;
  const getRuntimeAccountFn = input.getRuntimeAccount ?? getImRuntimeAccount;
  const updateAccountFn = input.updateAccount ?? updateImAccount;
  const createWorkerFn = input.createWorker ?? ((account: ImRuntimeAccount) => createOpenClawWeixinWorker({ account }));

  return {
    async startEnabledAccounts() {
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
      if (workers.has(accountId)) return;
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
      void updateAccountFn(accountId, {
        status: "stopped",
        lastStoppedAt: Date.now()
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
