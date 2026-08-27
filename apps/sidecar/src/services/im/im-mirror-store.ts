import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ImMirrorEntryPublic, ImMirrorSettingsPublic } from "@lume/shared";
import { getImMirrorConfigPath } from "../infra/config-paths";
import { backupCorruptFile } from "../infra/corrupt-file-backup";
import { createLogger } from "../infra/logger";
import { withIndexMutationLock } from "../infra/index-mutation-lock";

const CONFIG_VERSION = 1;
const log = createLogger("im-mirror");

interface ImMirrorConfig {
  version: number;
  /** 全局唯一承担镜像的账号；null=off。单字段使「仅允许一个承担者」结构性成立 */
  enabledMirrorAccountId: string | null;
  lastError?: string;
  mirrors: ImMirrorEntryPublic[];
}

export interface UpsertImMirrorEntryInput {
  threadId: string;
  accountId: string;
  chatId: string;
  carrier: ImMirrorEntryPublic["carrier"];
}

// ---------------------------------------------------------------------------
// 读写与并发控制：照抄 im-thread-binding-store 口径——原子写 + 0o600 + 损坏备份
// + 持锁 RMW；读不持锁（rename 后整文件一致快照）。
// 注意（#544 自环不变量）：此处绝不写入 im-thread-binding-store——「存在 DM 绑定」
// 是「IM 来源线程永不建群」的唯一判据，镜像映射混入绑定表会污染判定。
// ---------------------------------------------------------------------------
function mirrorConfigLockPath(): string {
  return `${getImMirrorConfigPath()}.lock`;
}

function backupCorruptMirrorFile(filePath: string): void {
  const backupPath = backupCorruptFile(filePath);
  if (backupPath) log.warn("backed up corrupt IM mirror config", { backupPath });
}

function readConfigUnlocked(): ImMirrorConfig {
  const path = getImMirrorConfigPath();
  if (!existsSync(path)) {
    return { version: CONFIG_VERSION, enabledMirrorAccountId: null, mirrors: [] };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    log.error("failed to read IM mirror config", { error });
    return { version: CONFIG_VERSION, enabledMirrorAccountId: null, mirrors: [] };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ImMirrorConfig>;
    return {
      version: Math.max(parsed.version ?? CONFIG_VERSION, CONFIG_VERSION),
      enabledMirrorAccountId: typeof parsed.enabledMirrorAccountId === "string" ? parsed.enabledMirrorAccountId : null,
      ...(typeof parsed.lastError === "string" ? { lastError: parsed.lastError } : {}),
      mirrors: Array.isArray(parsed.mirrors) ? parsed.mirrors : []
    };
  } catch {
    // 损坏先备份再重建，防止后续写入把空配置落盘静默清空全部映射
    backupCorruptMirrorFile(path);
    return { version: CONFIG_VERSION, enabledMirrorAccountId: null, mirrors: [] };
  }
}

function writeConfigUnlocked(config: ImMirrorConfig): void {
  const path = getImMirrorConfigPath();
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

function mutateConfig<T>(action: (config: ImMirrorConfig) => T): T {
  return withIndexMutationLock(mirrorConfigLockPath(), () => action(readConfigUnlocked()));
}

export function getImMirrorSettings(): ImMirrorSettingsPublic {
  const config = readConfigUnlocked();
  return {
    enabledMirrorAccountId: config.enabledMirrorAccountId,
    ...(config.lastError ? { lastError: config.lastError } : {})
  };
}

export function setMirrorOwnerAccountId(accountId: string | null): void {
  mutateConfig((config) => {
    config.enabledMirrorAccountId = accountId && accountId.trim() ? accountId.trim() : null;
    writeConfigUnlocked(config);
  });
}

export function listImMirrorEntries(): ImMirrorEntryPublic[] {
  return readConfigUnlocked().mirrors;
}

export function getImMirrorEntryByThreadId(threadId: string): ImMirrorEntryPublic | null {
  return readConfigUnlocked().mirrors.find((entry) => entry.threadId === threadId) ?? null;
}

export function getImMirrorEntryByChat(accountId: string, chatId: string): ImMirrorEntryPublic | null {
  return (
    readConfigUnlocked().mirrors.find(
      (entry) => entry.accountId === accountId && entry.chatId === chatId
    ) ?? null
  );
}

export function upsertImMirrorEntry(input: UpsertImMirrorEntryInput): ImMirrorEntryPublic {
  return mutateConfig((config) => {
    const threadId = input.threadId.trim();
    const index = config.mirrors.findIndex((entry) => entry.threadId === threadId);
    if (index >= 0) {
      // 幂等更新：同线程换 chat（罕见——退群后重新附着）跟随最新值
      const existing = config.mirrors[index] as ImMirrorEntryPublic;
      const updated: ImMirrorEntryPublic = {
        ...existing,
        accountId: input.accountId,
        chatId: input.chatId,
        carrier: input.carrier,
        lastError: undefined
      };
      config.mirrors[index] = updated;
      writeConfigUnlocked(config);
      return updated;
    }
    const entry: ImMirrorEntryPublic = {
      threadId,
      accountId: input.accountId,
      chatId: input.chatId,
      carrier: input.carrier,
      createdAt: Date.now()
    };
    config.mirrors.push(entry);
    writeConfigUnlocked(config);
    return entry;
  });
}

/** 记录账号级配置错误（建群失败权限文案等），null 清除；UI 在承担账号行内红字槽展示。 */
export function noteMirrorConfigError(accountId: string, error: string | null): void {
  mutateConfig((config) => {
    const applies =
      !config.enabledMirrorAccountId || config.enabledMirrorAccountId === accountId;
    const next = error ?? undefined;
    if (!applies || config.lastError === next) return;
    config.lastError = next;
    writeConfigUnlocked(config);
  });
}

export function removeImMirrorEntriesByThreadId(threadId: string): void {
  mutateConfig((config) => {
    const next = config.mirrors.filter((entry) => entry.threadId !== threadId);
    if (next.length === config.mirrors.length) return;
    writeConfigUnlocked({ ...config, mirrors: next });
  });
}

export function removeImMirrorEntriesForAccount(accountId: string): void {
  mutateConfig((config) => {
    const nextMirrors = config.mirrors.filter((entry) => entry.accountId !== accountId);
    const ownerCleared = config.enabledMirrorAccountId === accountId;
    if (nextMirrors.length === config.mirrors.length && !ownerCleared) return;
    writeConfigUnlocked({
      ...config,
      enabledMirrorAccountId: ownerCleared ? null : config.enabledMirrorAccountId,
      mirrors: nextMirrors
    });
  });
}
