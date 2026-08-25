import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type ImAccount,
  type ImAccountCreateInput,
  type ImAccountStatus,
  type ImAccountUpdateInput,
  type ImProvider,
  normalizeImAccountLabel
} from "@lume/shared";
import { getImConfigPath } from "../infra/config-paths";
import { decryptSecret, encryptSecret } from "../infra/secret-crypto";
import { createLogger } from "../infra/logger";
import { withIndexMutationLock } from "../infra/index-mutation-lock";

const CONFIG_VERSION = 1;
const log = createLogger("im-config");
const DEFAULT_WEIXIN_BASE_URL = "https://ilinkai.weixin.qq.com";

interface StoredImAccount extends Omit<ImAccount, "hasToken"> {
  encryptedToken?: string;
}

interface ImConfig {
  version: number;
  accounts: StoredImAccount[];
}

export interface ImRuntimeAccount extends ImAccount {
  token: string;
}

function normalizeBaseUrl(provider: ImProvider, baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim().replace(/\/+$/, "");
  if (trimmed) return trimmed;
  // 仅微信有默认服务端地址；钉钉/飞书/企微不走 baseUrl（凭据存 accountKey/token）
  return provider === "weixin" ? DEFAULT_WEIXIN_BASE_URL : "";
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

// ---------------------------------------------------------------------------
// 读写与并发控制（#158）：原子写 + 0o600 + 损坏备份 + 持锁 RMW。
// 读函数不持锁（rename 后的整文件一致快照）；变更函数走 mutateConfig（withIndexMutationLock
// 非重入，锁内一律调无锁变体——upsertImAccountFromLogin 内部转调即此场景）。
// ---------------------------------------------------------------------------
function imConfigLockPath(): string {
  return `${getImConfigPath()}.lock`;
}

/** 仅 JSON.parse 失败（真损坏）才备份重建；瞬态 IO 读错误不备份，防止把好文件"备份后清空"。 */
function backupCorruptFile(filePath: string): void {
  const backupPath = `${filePath}.corrupt-${Date.now()}`;
  try {
    renameSync(filePath, backupPath);
    log.warn("backed up corrupt IM config", { backupPath });
  } catch (error) {
    log.warn("failed to back up corrupt IM config", { backupPath, error: error instanceof Error ? error.message : String(error) });
  }
}

function readConfigUnlocked(): ImConfig {
  const path = getImConfigPath();
  if (!existsSync(path)) {
    return { version: CONFIG_VERSION, accounts: [] };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    log.error("failed to read IM configuration", { error });
    return { version: CONFIG_VERSION, accounts: [] };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ImConfig>;
    return {
      version: Math.max(parsed.version ?? CONFIG_VERSION, CONFIG_VERSION),
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : []
    };
  } catch {
    // 文件截断损坏：先备份再重建，防止后续写操作把空配置落盘静默清空全部账号（含加密 token）
    backupCorruptFile(path);
    return { version: CONFIG_VERSION, accounts: [] };
  }
}

function writeConfigUnlocked(config: ImConfig): void {
  const path = getImConfigPath();
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

function readConfig(): ImConfig {
  return readConfigUnlocked();
}

function mutateConfig<T>(action: (config: ImConfig) => T): T {
  return withIndexMutationLock(imConfigLockPath(), () => action(readConfigUnlocked()));
}

function toPublicAccount(account: StoredImAccount): ImAccount {
  return {
    id: account.id,
    provider: account.provider,
    accountKey: account.accountKey,
    label: account.label,
    uin: account.uin,
    workspaceId: account.workspaceId,
    baseUrl: account.baseUrl,
    enabled: account.enabled,
    status: account.status,
    hasToken: Boolean(account.encryptedToken),
    cursor: account.cursor,
    contextToken: account.contextToken,
    lastError: account.lastError,
    lastStartedAt: account.lastStartedAt,
    lastStoppedAt: account.lastStoppedAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

function findStoredAccount(config: ImConfig, id: string): StoredImAccount {
  const account = config.accounts.find((item) => item.id === id);
  if (!account) {
    throw new Error(`IM 账号不存在: ${id}`);
  }
  return account;
}

export function listImAccounts(): ImAccount[] {
  return readConfig().accounts.map(toPublicAccount);
}

export function getImAccount(id: string): ImAccount | null {
  const account = readConfig().accounts.find((item) => item.id === id);
  return account ? toPublicAccount(account) : null;
}

/**
 * #637：把存量 legacy 弱种子密文一次性升级为注入密钥的 v2 密文。
 * 返回迁移条数；v2 条目跳过。持锁执行，与并发写互斥。
 */
export function reencryptImTokensWithInstalledKey(): number {
  return mutateConfig((config) => {
    let migrated = 0;
    for (const account of config.accounts) {
      if (!account.encryptedToken || account.encryptedToken.startsWith("enc:v2:")) continue;
      account.encryptedToken = encryptSecret(decryptSecret(account.encryptedToken));
      migrated += 1;
    }
    if (migrated > 0) writeConfigUnlocked(config);
    return migrated;
  });
}
export function getImRuntimeAccount(id: string): ImRuntimeAccount {
  const config = readConfig();
  const account = findStoredAccount(config, id);
  if (!account.encryptedToken) {
    throw new Error(`IM 账号缺少 token: ${id}`);
  }
  return {
    ...toPublicAccount(account),
    token: decryptSecret(account.encryptedToken)
  };
}

export function getImAccountSecret(id: string): string {
  return getImRuntimeAccount(id).token;
}

export function createImAccount(input: ImAccountCreateInput): ImAccount {
  return mutateConfig((config) => {
    const now = Date.now();
    const account: StoredImAccount = {
      id: randomUUID(),
      provider: input.provider,
      accountKey: normalizeOptional(input.accountKey),
      label: normalizeImAccountLabel(input),
      uin: normalizeOptional(input.uin),
      workspaceId: normalizeOptional(input.workspaceId),
      baseUrl: normalizeBaseUrl(input.provider, input.baseUrl),
      enabled: input.enabled ?? false,
      status: "stopped",
      encryptedToken: encryptSecret(input.token.trim()),
      createdAt: now,
      updatedAt: now
    };
    config.accounts.push(account);
    writeConfigUnlocked(config);
    return toPublicAccount(account);
  });
}

export function upsertImAccountFromLogin(input: ImAccountCreateInput): ImAccount {
  // 整个 upsert 持一把锁：两次独立持锁的 find+create/update 之间并发登录会产生重复账号
  return mutateConfig((config) => {
    const accountKey = normalizeOptional(input.accountKey);
    if (!accountKey) {
      return createImAccountUnlocked(config, input);
    }
    const existing = config.accounts.find((account) =>
      account.provider === input.provider && account.accountKey === accountKey
    );
    if (!existing) {
      return createImAccountUnlocked(config, input);
    }
    return updateImAccountUnlocked(config, existing.id, {
      accountKey,
      label: input.label,
      token: input.token,
      uin: input.uin,
      workspaceId: input.workspaceId,
      baseUrl: input.baseUrl,
      enabled: input.enabled ?? existing.enabled,
      status: "stopped",
      lastError: null
    });
  });
}

function createImAccountUnlocked(config: ImConfig, input: ImAccountCreateInput): ImAccount {
  const now = Date.now();
  const account: StoredImAccount = {
    id: randomUUID(),
    provider: input.provider,
    accountKey: normalizeOptional(input.accountKey),
    label: normalizeImAccountLabel(input),
    uin: normalizeOptional(input.uin),
    workspaceId: normalizeOptional(input.workspaceId),
    baseUrl: normalizeBaseUrl(input.provider, input.baseUrl),
    enabled: input.enabled ?? false,
    status: "stopped",
    encryptedToken: encryptSecret(input.token.trim()),
    createdAt: now,
    updatedAt: now
  };
  config.accounts.push(account);
  writeConfigUnlocked(config);
  return toPublicAccount(account);
}

export function updateImAccount(id: string, input: ImAccountUpdateInput): ImAccount {
  return mutateConfig((config) => updateImAccountUnlocked(config, id, input));
}

function updateImAccountUnlocked(config: ImConfig, id: string, input: ImAccountUpdateInput): ImAccount {
  const index = config.accounts.findIndex((item) => item.id === id);
  if (index === -1) {
    throw new Error(`IM 账号不存在: ${id}`);
  }
  const existing = config.accounts[index] as StoredImAccount;
  const nextUin = input.uin !== undefined ? normalizeOptional(input.uin) : existing.uin;
  const updated: StoredImAccount = {
    ...existing,
    ...(input.accountKey !== undefined ? { accountKey: normalizeOptional(input.accountKey) } : {}),
    ...(input.label !== undefined ? { label: normalizeImAccountLabel({ provider: existing.provider, label: input.label, uin: nextUin }) } : {}),
    ...(input.uin !== undefined ? { uin: nextUin } : {}),
    ...(input.workspaceId !== undefined ? { workspaceId: normalizeOptional(input.workspaceId) } : {}),
    ...(input.baseUrl !== undefined ? { baseUrl: normalizeBaseUrl(existing.provider, input.baseUrl) } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.status !== undefined ? { status: input.status as ImAccountStatus } : {}),
    ...(input.cursor !== undefined ? { cursor: normalizeOptional(input.cursor) } : {}),
    ...(input.contextToken !== undefined ? { contextToken: normalizeOptional(input.contextToken) } : {}),
    ...(input.lastError !== undefined ? { lastError: input.lastError === null ? undefined : input.lastError } : {}),
    ...(input.lastStartedAt !== undefined ? { lastStartedAt: input.lastStartedAt } : {}),
    ...(input.lastStoppedAt !== undefined ? { lastStoppedAt: input.lastStoppedAt } : {}),
    ...(input.token !== undefined && input.token.trim() ? { encryptedToken: encryptSecret(input.token.trim()) } : {}),
    updatedAt: Date.now()
  };
  config.accounts[index] = updated;
  writeConfigUnlocked(config);
  return toPublicAccount(updated);
}

export function deleteImAccount(id: string): void {
  mutateConfig((config) => {
    const index = config.accounts.findIndex((item) => item.id === id);
    if (index === -1) {
      throw new Error(`IM 账号不存在: ${id}`);
    }
    config.accounts.splice(index, 1);
    writeConfigUnlocked(config);
  });
}

export function listImAccountsForWorkspace(workspaceId: string): ImAccount[] {
  return listImAccounts().filter((account) => account.workspaceId === workspaceId);
}

export function clearImAccountWorkspaceBindings(workspaceId: string): ImAccount[] {
  return mutateConfig((config) => {
    let changed = false;
    const now = Date.now();
    const affectedIds = new Set<string>();
    const updatedAccounts = config.accounts.map((account) => {
      if (account.workspaceId !== workspaceId) return account;
      changed = true;
      affectedIds.add(account.id);
      return {
        ...account,
        workspaceId: undefined,
        updatedAt: now
      };
    });
    if (changed) {
      writeConfigUnlocked({ ...config, accounts: updatedAccounts });
    }
    return updatedAccounts
      .filter((account) => affectedIds.has(account.id))
      .map(toPublicAccount);
  });
}
