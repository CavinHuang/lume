import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

function readConfig(): ImConfig {
  const path = getImConfigPath();
  if (!existsSync(path)) {
    return { version: CONFIG_VERSION, accounts: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ImConfig>;
    return {
      version: Math.max(parsed.version ?? CONFIG_VERSION, CONFIG_VERSION),
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : []
    };
  } catch (error) {
    log.error("failed to read IM configuration", { error });
    return { version: CONFIG_VERSION, accounts: [] };
  }
}

function writeConfig(config: ImConfig): void {
  writeFileSync(getImConfigPath(), JSON.stringify(config, null, 2), "utf-8");
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

export function listImAccountSecrets(): string[] {
  return readConfig().accounts
    .map((account) => account.encryptedToken ? decryptSecret(account.encryptedToken) : undefined)
    .filter((token): token is string => Boolean(token));
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
  const config = readConfig();
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
  writeConfig(config);
  return toPublicAccount(account);
}

export function upsertImAccountFromLogin(input: ImAccountCreateInput): ImAccount {
  const accountKey = normalizeOptional(input.accountKey);
  if (!accountKey) {
    return createImAccount(input);
  }
  const existing = readConfig().accounts.find((account) =>
    account.provider === input.provider && account.accountKey === accountKey
  );
  if (!existing) {
    return createImAccount(input);
  }
  return updateImAccount(existing.id, {
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
}

export function updateImAccount(id: string, input: ImAccountUpdateInput): ImAccount {
  const config = readConfig();
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
  writeConfig(config);
  return toPublicAccount(updated);
}

export function deleteImAccount(id: string): void {
  const config = readConfig();
  const index = config.accounts.findIndex((item) => item.id === id);
  if (index === -1) {
    throw new Error(`IM 账号不存在: ${id}`);
  }
  config.accounts.splice(index, 1);
  writeConfig(config);
}

export function listImAccountsForWorkspace(workspaceId: string): ImAccount[] {
  return listImAccounts().filter((account) => account.workspaceId === workspaceId);
}

export function clearImAccountWorkspaceBindings(workspaceId: string): ImAccount[] {
  const config = readConfig();
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
    writeConfig({ ...config, accounts: updatedAccounts });
  }
  return updatedAccounts
    .filter((account) => affectedIds.has(account.id))
    .map(toPublicAccount);
}
