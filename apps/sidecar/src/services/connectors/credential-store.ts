import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { getConnectorCredentialsPath } from "../infra/config-paths";
import { withIndexMutationLock } from "../infra/index-mutation-lock";
import { decrypt, encrypt } from "../channel/connection-credential-store";
import type { ResolvedCredential } from "./core/types";

/** 用户自带的 OAuth app 配置(迁移自 open-connector oauth-client-config-service 的最小子集)。 */
export interface ConnectorOAuthClientConfig {
  service: string;
  clientId: string;
  clientSecret: string;
  /** 非空的 provider 已声明 scope 子集;缺省用 provider 默认全量。 */
  requestedScopes?: string[];
  extra: Record<string, string>;
  secretExtra: Record<string, string>;
}

/**
 * 单个连接器的本地凭证:OAuth app 配置(用户自带 client_id/secret)+ 授权后的 token。
 * 每条记录整体 JSON 序列化后经 connection vault(AES-256-GCM)加密落盘。
 */
export interface ConnectorCredentialRecord {
  clientConfig?: ConnectorOAuthClientConfig;
  oauth?: ResolvedCredential & { authType: "oauth2" };
}

interface ConnectorCredentialFile {
  version: 1;
  /** service → 加密后的 record JSON(vault:v1:...)。 */
  credentials: Record<string, string>;
}

function emptyFile(): ConnectorCredentialFile {
  return { version: 1, credentials: {} };
}

function readStore(): ConnectorCredentialFile {
  const path = getConnectorCredentialsPath();
  if (!existsSync(path)) return emptyFile();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ConnectorCredentialFile>;
    if (!parsed.credentials || typeof parsed.credentials !== "object") return emptyFile();
    return { version: 1, credentials: parsed.credentials };
  } catch {
    return emptyFile();
  }
}

function writeStore(file: ConnectorCredentialFile): void {
  const path = getConnectorCredentialsPath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(file), "utf8");
  renameSync(tmp, path);
}

function readRecord(service: string): ConnectorCredentialRecord {
  const raw = readStore().credentials[service];
  if (!raw) return {};
  try {
    return JSON.parse(decrypt(raw)) as ConnectorCredentialRecord;
  } catch {
    // vault key 轮换或记录损坏时视为未配置,不抛错阻断启动
    return {};
  }
}

function withRecord(service: string, mutate: (record: ConnectorCredentialRecord) => ConnectorCredentialRecord): void {
  withIndexMutationLock(`${getConnectorCredentialsPath()}.lock`, () => {
    const file = readStore();
    const next = mutate(readRecord(service));
    file.credentials[service] = encrypt(JSON.stringify(next));
    writeStore(file);
  });
}

export function getConnectorClientConfig(service: string): ConnectorOAuthClientConfig | undefined {
  return readRecord(service).clientConfig;
}

export function setConnectorClientConfig(service: string, config: ConnectorOAuthClientConfig): void {
  withRecord(service, (record) => ({ ...record, clientConfig: config }));
}

export function getConnectorOAuthCredential(service: string): (ResolvedCredential & { authType: "oauth2" }) | undefined {
  return readRecord(service).oauth;
}

export function setConnectorOAuthCredential(
  service: string,
  credential: ResolvedCredential & { authType: "oauth2" },
): void {
  withRecord(service, (record) => ({ ...record, oauth: credential }));
}

export function deleteConnectorCredential(service: string): void {
  withIndexMutationLock(`${getConnectorCredentialsPath()}.lock`, () => {
    const file = readStore();
    if (!(service in file.credentials)) return;
    delete file.credentials[service];
    writeStore(file);
  });
}
