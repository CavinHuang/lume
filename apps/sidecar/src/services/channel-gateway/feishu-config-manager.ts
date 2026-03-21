import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type {
  FeishuGatewayConfig,
  FeishuGatewayConfigInput,
  FeishuGatewayConfigView
} from "@lume/shared";
import { getChannelGatewayFeishuConfigPath } from "../config-paths";

const AES_ALGO = "aes-256-gcm";
const CONFIG_VERSION = 1;
const DEFAULT_WEBHOOK_PATH = "/webhook/feishu";

interface StoredFeishuGatewayConfig {
  version: number;
  enabled: boolean;
  appId: string;
  appSecretEnc: string;
  verificationTokenEnc: string;
  encryptKeyEnc?: string;
  domain: "feishu" | "lark";
  defaultWorkspaceId?: string;
  webhookPath: string;
}

function getEncryptionKey(): Buffer {
  const seed = process.env.LUME_SECRET_SEED ?? `${process.env.USERNAME ?? "user"}::${process.env.HOME ?? "home"}::lume`;
  return createHash("sha256").update(seed).digest();
}

function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(AES_ALGO, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptSecret(value: string): string {
  const data = Buffer.from(value, "base64");
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = createDecipheriv(AES_ALGO, getEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function writeAtomic(path: string, payload: string): void {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

function defaultStoredConfig(): StoredFeishuGatewayConfig {
  return {
    version: CONFIG_VERSION,
    enabled: false,
    appId: "",
    appSecretEnc: "",
    verificationTokenEnc: "",
    domain: "feishu",
    webhookPath: DEFAULT_WEBHOOK_PATH
  };
}

function normalizeWebhookPath(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_WEBHOOK_PATH;
  const normalized = raw.startsWith("/") ? raw : `/${raw}`;
  return normalized.replace(/\/+$/, "") || DEFAULT_WEBHOOK_PATH;
}

function readStored(): StoredFeishuGatewayConfig {
  const path = getChannelGatewayFeishuConfigPath();
  if (!existsSync(path)) return defaultStoredConfig();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<StoredFeishuGatewayConfig>;
    return {
      version: CONFIG_VERSION,
      enabled: parsed.enabled === true,
      appId: typeof parsed.appId === "string" ? parsed.appId : "",
      appSecretEnc: typeof parsed.appSecretEnc === "string" ? parsed.appSecretEnc : "",
      verificationTokenEnc: typeof parsed.verificationTokenEnc === "string" ? parsed.verificationTokenEnc : "",
      encryptKeyEnc: typeof parsed.encryptKeyEnc === "string" ? parsed.encryptKeyEnc : undefined,
      domain: parsed.domain === "lark" ? "lark" : "feishu",
      defaultWorkspaceId: typeof parsed.defaultWorkspaceId === "string" ? parsed.defaultWorkspaceId : undefined,
      webhookPath: normalizeWebhookPath(parsed.webhookPath)
    };
  } catch (error) {
    console.error("[ChannelGateway] 读取飞书配置失败:", error);
    return defaultStoredConfig();
  }
}

function toPublicView(stored: StoredFeishuGatewayConfig): FeishuGatewayConfigView {
  return {
    version: stored.version,
    enabled: stored.enabled,
    appId: stored.appId,
    hasAppSecret: Boolean(stored.appSecretEnc),
    hasVerificationToken: Boolean(stored.verificationTokenEnc),
    hasEncryptKey: Boolean(stored.encryptKeyEnc),
    domain: stored.domain,
    ...(stored.defaultWorkspaceId ? { defaultWorkspaceId: stored.defaultWorkspaceId } : {}),
    webhookPath: stored.webhookPath
  };
}

function toRuntimeConfig(stored: StoredFeishuGatewayConfig): FeishuGatewayConfig {
  return {
    version: stored.version,
    enabled: stored.enabled,
    appId: stored.appId,
    appSecret: stored.appSecretEnc ? decryptSecret(stored.appSecretEnc) : "",
    verificationToken: stored.verificationTokenEnc ? decryptSecret(stored.verificationTokenEnc) : "",
    ...(stored.encryptKeyEnc ? { encryptKey: decryptSecret(stored.encryptKeyEnc) } : {}),
    domain: stored.domain,
    ...(stored.defaultWorkspaceId ? { defaultWorkspaceId: stored.defaultWorkspaceId } : {}),
    webhookPath: stored.webhookPath
  };
}

function writeStored(stored: StoredFeishuGatewayConfig): void {
  writeAtomic(getChannelGatewayFeishuConfigPath(), JSON.stringify(stored, null, 2));
}

export function getFeishuGatewayConfigView(): FeishuGatewayConfigView {
  return toPublicView(readStored());
}

export function getFeishuGatewayConfig(): FeishuGatewayConfig {
  return toRuntimeConfig(readStored());
}

export function saveFeishuGatewayConfig(input: FeishuGatewayConfigInput): FeishuGatewayConfigView {
  const current = readStored();
  const next: StoredFeishuGatewayConfig = {
    ...current,
    version: CONFIG_VERSION,
    enabled: input.enabled,
    appId: input.appId.trim(),
    domain: input.domain === "lark" ? "lark" : "feishu",
    defaultWorkspaceId: input.defaultWorkspaceId?.trim() || undefined,
    webhookPath: normalizeWebhookPath(input.webhookPath)
  };

  if (input.appSecret !== undefined) {
    const secret = input.appSecret.trim();
    next.appSecretEnc = secret ? encryptSecret(secret) : "";
  }
  if (input.verificationToken !== undefined) {
    const token = input.verificationToken.trim();
    next.verificationTokenEnc = token ? encryptSecret(token) : "";
  }
  if (input.encryptKey !== undefined) {
    const key = input.encryptKey.trim();
    next.encryptKeyEnc = key ? encryptSecret(key) : undefined;
  }

  writeStored(next);
  return toPublicView(next);
}
