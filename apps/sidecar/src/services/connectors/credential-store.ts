import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { getConnectorCredentialsPath } from "../infra/config-paths";
import { withIndexMutationLock } from "../infra/index-mutation-lock";
import { decrypt, encrypt } from "../channel/connection-credential-store";
import { createLogger } from "../infra/logger";
import type { ResolvedCredential } from "./core/types";

const logger = createLogger("connectors.vault");

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
  /** 授权码型凭证(QQ 邮箱等):字段表由 provider definition 声明。 */
  customValues?: Record<string, string>;
}

interface ConnectorCredentialFile {
  version: 1;
  /** service → 加密后的 record JSON(vault:v1:...)。 */
  credentials: Record<string, string>;
}

function emptyFile(): ConnectorCredentialFile {
  return { version: 1, credentials: {} };
}

/**
 * 上一次 readStore 是否遇到无法解析的文件。读取侧降级为空(保 UI 可用),
 * 写入侧据此拒绝覆盖——否则一次成功的小写入会把整个密文集合覆盖成单条记录,
 * 其余服务的凭证被静默抹掉。
 */
let storeUnreadable = false;

function readStore(): ConnectorCredentialFile {
  const path = getConnectorCredentialsPath();
  if (!existsSync(path)) {
    storeUnreadable = false;
    return emptyFile();
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ConnectorCredentialFile>;
    if (!parsed.credentials || typeof parsed.credentials !== "object") throw new Error("shape_invalid");
    storeUnreadable = false;
    return { version: 1, credentials: parsed.credentials };
  } catch (error) {
    storeUnreadable = true;
    logger.error(
      "connector-credentials.json 无法解析,vault 内容按未配置展示;写入将被拒绝以免覆盖现存凭证",
      { error: error instanceof Error ? error.message : String(error) },
    );
    return emptyFile();
  }
}

function writeStore(file: ConnectorCredentialFile): void {
  if (storeUnreadable) {
    throw new Error("connector_credentials_unreadable_refuse_overwrite");
  }
  const path = getConnectorCredentialsPath();
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(file), { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (error) {
    // wx 撞上陈留 tmp(上次写后 rename 前进程中断):锁内独占,tmp 必然是死物,清掉重试一次
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      rmSync(tmp, { force: true });
      writeFileSync(tmp, JSON.stringify(file), { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(tmp, path);
      return;
    }
    throw error;
  }
}

/** 密文不可解(vault key 轮换/记录损坏)时返回 undefined;调用方决定降级或拒写。 */
function decodeRecord(service: string, raw: string | undefined): ConnectorCredentialRecord | undefined {
  if (!raw) return {};
  try {
    return JSON.parse(decrypt(raw)) as ConnectorCredentialRecord;
  } catch (error) {
    logger.warn("凭证记录不可解(vault key 轮换或记录损坏),暂按未连接处理", {
      service,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function readRecord(service: string): ConnectorCredentialRecord {
  // vault key 轮换或记录损坏时视为未配置,不抛错阻断启动
  return decodeRecord(service, readStore().credentials[service]) ?? {};
}

function withRecord(service: string, mutate: (record: ConnectorCredentialRecord) => ConnectorCredentialRecord): void {
  withIndexMutationLock(`${getConnectorCredentialsPath()}.lock`, () => {
    const file = readStore();
    const decoded = decodeRecord(service, file.credentials[service]);
    if (decoded === undefined) {
      // 该条密文仍存在但解不开:盲写会把残留的 clientConfig 一并抹掉;
      // 显式断开(deleteConnectorCredential)后可重新配置
      throw new Error(`connector_credential_record_unreadable: ${service}(请先断开该服务再重新配置)`);
    }
    const next = mutate(decoded);
    file.credentials[service] = encrypt(JSON.stringify(next));
    writeStore(file);
  });
}

/** 一次性读取整条记录:status 组装等需要多个字段的场景,免去逐字段重复读盘解密。 */
export function getConnectorCredentialRecord(service: string): ConnectorCredentialRecord {
  return readRecord(service);
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

export function getConnectorCustomValues(service: string): Record<string, string> | undefined {
  return readRecord(service).customValues;
}

export function setConnectorCustomValues(service: string, values: Record<string, string>): void {
  withRecord(service, (record) => ({ ...record, customValues: values }));
}

/** 仅清凭证数据(oauth/customValues),保留用户手填的 OAuth client 配置。 */
export function clearConnectorCredentialData(service: string): void {
  withIndexMutationLock(`${getConnectorCredentialsPath()}.lock`, () => {
    if (storeUnreadable) {
      // 文件级损坏:内容已不可读,删坏文件即恢复(否则断开重连路径死循环)
      rmSync(getConnectorCredentialsPath(), { force: true });
      storeUnreadable = false;
      return;
    }
    const file = readStore();
    const decoded = decodeRecord(service, file.credentials[service]);
    if (decoded === undefined) {
      // 密文不可解:整条丢弃
      delete file.credentials[service];
    } else if (decoded.clientConfig) {
      file.credentials[service] = encrypt(JSON.stringify({ clientConfig: decoded.clientConfig }));
    } else {
      delete file.credentials[service];
    }
    writeStore(file);
  });
}

export function deleteConnectorCredential(service: string): void {
  withIndexMutationLock(`${getConnectorCredentialsPath()}.lock`, () => {
    // 文件级损坏:内容已不可读,删除损坏文件即恢复——否则"先断开再重连"
    // 的自救路径会在这里静默 no-op,用户永远卡在写入被拒
    if (storeUnreadable) {
      rmSync(getConnectorCredentialsPath(), { force: true });
      storeUnreadable = false;
      return;
    }
    const file = readStore();
    if (!(service in file.credentials)) return;
    delete file.credentials[service];
    writeStore(file);
  });
}
