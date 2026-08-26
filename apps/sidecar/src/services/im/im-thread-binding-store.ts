import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ImPeerRef, ImThreadBinding } from "@lume/shared";
import { getImThreadBindingsPath } from "../infra/config-paths";
import { backupCorruptFile } from "../infra/corrupt-file-backup";
import { createLogger } from "../infra/logger";
import { withIndexMutationLock } from "../infra/index-mutation-lock";

const CONFIG_VERSION = 1;
const log = createLogger("im-thread-bindings");

interface ImThreadBindingConfig {
  version: number;
  bindings: ImThreadBinding[];
}

export interface UpsertImThreadBindingInput extends ImPeerRef {
  peerName?: string;
  threadId: string;
  contextToken?: string;
}

// 读写与并发控制（#158）：原子写 + 0o600 + 损坏备份 + 持锁 RMW；读不持锁（rename 后整文件一致快照）
function bindingStoreLockPath(): string {
  return `${getImThreadBindingsPath()}.lock`;
}

/** 仅 JSON.parse 失败（真损坏）才备份重建；瞬态 IO 读错误不备份，防止把好文件"备份后清空"。 */
function backupCorruptBindingsFile(filePath: string): void {
  const backupPath = backupCorruptFile(filePath);
  if (backupPath) log.warn("backed up corrupt IM thread bindings", { backupPath });
}

function readConfigUnlocked(): ImThreadBindingConfig {
  const path = getImThreadBindingsPath();
  if (!existsSync(path)) {
    return { version: CONFIG_VERSION, bindings: [] };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    log.error("failed to read IM thread bindings", { error });
    return { version: CONFIG_VERSION, bindings: [] };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ImThreadBindingConfig>;
    return {
      version: Math.max(parsed.version ?? CONFIG_VERSION, CONFIG_VERSION),
      bindings: Array.isArray(parsed.bindings) ? parsed.bindings : []
    };
  } catch {
    // 损坏先备份再重建，防止后续写入把空绑定落盘导致全部 IM 会话割裂
    backupCorruptBindingsFile(path);
    return { version: CONFIG_VERSION, bindings: [] };
  }
}

function writeConfigUnlocked(config: ImThreadBindingConfig): void {
  const path = getImThreadBindingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2), "utf-8");
  try {
    chmodSync(temporary, 0o600);
  } catch {
    // Windows 基本忽略 POSIX 权限位，失败不阻断写入
  }
  renameSync(temporary, path);
}

function mutateConfig<T>(action: (config: ImThreadBindingConfig) => T): T {
  return withIndexMutationLock(bindingStoreLockPath(), () => action(readConfigUnlocked()));
}

export function createImBindingKey(ref: ImPeerRef): string {
  return `${ref.provider}/${ref.accountId}/${ref.peerKind}/${ref.peerId}`;
}

export function listImThreadBindings(): ImThreadBinding[] {
  return readConfigUnlocked().bindings;
}

export function getImThreadBindingByPeer(ref: ImPeerRef): ImThreadBinding | null {
  const key = createImBindingKey(ref);
  return readConfigUnlocked().bindings.find((binding) => binding.key === key) ?? null;
}

export function getImThreadBindingByThreadId(threadId: string): ImThreadBinding | null {
  return readConfigUnlocked().bindings.find((binding) => binding.threadId === threadId) ?? null;
}

export function upsertImThreadBinding(input: UpsertImThreadBindingInput): ImThreadBinding {
  return mutateConfig((config) => {
    const key = createImBindingKey(input);
    const now = Date.now();
    const index = config.bindings.findIndex((binding) => binding.key === key);
    if (index >= 0) {
      const existing = config.bindings[index] as ImThreadBinding;
      const updated: ImThreadBinding = {
        ...existing,
        peerName: input.peerName ?? existing.peerName,
        contextToken: input.contextToken ?? existing.contextToken,
        updatedAt: now
      };
      config.bindings[index] = updated;
      writeConfigUnlocked(config);
      return updated;
    }

    const binding: ImThreadBinding = {
      key,
      provider: input.provider,
      accountId: input.accountId,
      peerKind: input.peerKind,
      peerId: input.peerId,
      peerName: input.peerName,
      threadId: input.threadId,
      contextToken: input.contextToken,
      createdAt: now,
      updatedAt: now
    };
    config.bindings.push(binding);
    writeConfigUnlocked(config);
    return binding;
  });
}

/** 按 peer 精确删除绑定（如 IM /new 命令重开会话时先解除旧线程绑定）。 */
export function deleteImThreadBindingByPeer(ref: ImPeerRef): void {
  mutateConfig((config) => {
    const key = createImBindingKey(ref);
    const next = config.bindings.filter((binding) => binding.key !== key);
    if (next.length === config.bindings.length) return;
    writeConfigUnlocked({ ...config, bindings: next });
  });
}

export function deleteImThreadBindingsForAccount(accountId: string): void {
  mutateConfig((config) => {
    const nextBindings = config.bindings.filter((binding) => binding.accountId !== accountId);
    if (nextBindings.length === config.bindings.length) return;
    writeConfigUnlocked({ ...config, bindings: nextBindings });
  });
}

export function listImThreadBindingsForThreadIds(threadIds: Set<string>): ImThreadBinding[] {
  return readConfigUnlocked().bindings.filter((binding) => threadIds.has(binding.threadId));
}

export function deleteImThreadBindingsForThreadIds(threadIds: Set<string>): ImThreadBinding[] {
  return mutateConfig((config) => {
    const removed = config.bindings.filter((binding) => threadIds.has(binding.threadId));
    if (removed.length === 0) return [];
    const nextBindings = config.bindings.filter((binding) => !threadIds.has(binding.threadId));
    writeConfigUnlocked({ ...config, bindings: nextBindings });
    return removed;
  });
}
