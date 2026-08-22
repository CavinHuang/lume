import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { getConnectionCredentialsPath } from "../infra/config-paths";
import { withIndexMutationLock } from "../infra/index-mutation-lock";
import type { OAuthCredential } from "@earendil-works/pi-ai";

interface ConnectionCredentialRecord {
  apiKey?: string;
  oauth?: string;
}

interface ConnectionCredentialFile {
  version: 1;
  credentials: Record<string, ConnectionCredentialRecord>;
}

let vaultKey: Buffer | undefined;

function requireVaultKey(): Buffer {
  if (!vaultKey) throw new Error("connection_vault_locked");
  return vaultKey;
}

export function installConnectionVaultKey(value: unknown): void {
  if (typeof value !== "string") throw new Error("connection_vault_key_invalid");
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32) {
    decoded.fill(0);
    throw new Error("connection_vault_key_invalid");
  }
  vaultKey?.fill(0);
  vaultKey = Buffer.from(decoded);
  decoded.fill(0);
}

export function isConnectionVaultUnlocked(): boolean {
  return vaultKey?.length === 32;
}

function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", requireVaultKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `vault:v1:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")}`;
}

function decrypt(value: string): string {
  if (!value.startsWith("vault:v1:")) throw new Error("connection_vault_record_invalid");
  const payload = Buffer.from(value.slice("vault:v1:".length), "base64");
  if (payload.length < 29) throw new Error("connection_vault_record_invalid");
  const decipher = createDecipheriv("aes-256-gcm", requireVaultKey(), payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(12, 28));
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8");
}

function readStore(): ConnectionCredentialFile {
  const path = getConnectionCredentialsPath();
  if (!existsSync(path)) return { version: 1, credentials: {} };
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ConnectionCredentialFile>;
  return {
    version: 1,
    credentials: value.credentials && typeof value.credentials === "object" ? value.credentials : {},
  };
}

function writeStore(value: ConnectionCredentialFile): void {
  const path = getConnectionCredentialsPath();
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

function updateRecord(
  connectionId: string,
  update: (current: ConnectionCredentialRecord) => ConnectionCredentialRecord | undefined,
): void {
  // 读改写全程持锁：并发更新（如 OAuth 刷新与另一连接 setApiKey）无锁时整文件
  // 互相覆盖、丢一侧凭据——同仓 im-config/channel-manager 均已持锁，唯此处曾漏（#405）
  withIndexMutationLock(`${getConnectionCredentialsPath()}.lock`, () => {
    const store = readStore();
    const next = update(store.credentials[connectionId] ?? {});
    if (next && Object.keys(next).length > 0) store.credentials[connectionId] = next;
    else delete store.credentials[connectionId];
    writeStore(store);
  });
}

export function hasConnectionApiKey(connectionId: string): boolean {
  return Boolean(readStore().credentials[connectionId]?.apiKey);
}

export function setConnectionApiKey(connectionId: string, apiKey: string): void {
  const trimmed = apiKey.trim();
  updateRecord(connectionId, (current) => trimmed
    ? { ...current, apiKey: encrypt(trimmed) }
    : { ...current, apiKey: undefined });
}

export function deleteConnectionApiKey(connectionId: string): void {
  const path = getConnectionCredentialsPath();
  if (!existsSync(path)) return;
  updateRecord(connectionId, (current) => ({ ...current, apiKey: undefined }));
}

export function getConnectionApiKey(connectionId: string): string {
  const encrypted = readStore().credentials[connectionId]?.apiKey;
  if (!encrypted) return "";
  return decrypt(encrypted);
}

export function setConnectionOAuthCredential(connectionId: string, credential: OAuthCredential): void {
  updateRecord(connectionId, (current) => ({
    ...current,
    oauth: encrypt(JSON.stringify(credential)),
  }));
}

export function getConnectionOAuthCredential(connectionId: string): OAuthCredential | undefined {
  const encrypted = readStore().credentials[connectionId]?.oauth;
  if (!encrypted) return undefined;
  const value = JSON.parse(decrypt(encrypted)) as OAuthCredential;
  if (value.type !== "oauth" || typeof value.access !== "string" || typeof value.refresh !== "string") {
    throw new Error("connection_oauth_record_invalid");
  }
  return value;
}

export function hasConnectionOAuthCredential(connectionId: string): boolean {
  return Boolean(readStore().credentials[connectionId]?.oauth);
}

export function deleteConnectionOAuthCredential(connectionId: string): void {
  const path = getConnectionCredentialsPath();
  if (!existsSync(path)) return;
  updateRecord(connectionId, (current) => ({ ...current, oauth: undefined }));
}

export function deleteConnectionCredentials(connectionId: string): void {
  const path = getConnectionCredentialsPath();
  if (!existsSync(path)) return;
  updateRecord(connectionId, () => undefined);
}
