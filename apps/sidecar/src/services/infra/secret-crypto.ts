import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const AES_ALGO = "aes-256-gcm";
const V2_PREFIX = "enc:v2:";

let installedKey: Buffer | undefined;

/**
 * 主进程经 RPC 注入的应用级随机密钥（safeStorage 包裹落盘，仅原机可解）。
 * 注入后新密文脱离可推导种子（#617）；存量旧密文仍按 legacy 种子读取，
 * 消费方重存配置时自然升级为 v2。
 */
export function installSecretEncryptionKey(value: unknown): void {
  if (typeof value !== "string") throw new Error("secret_encryption_key_invalid");
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32) {
    decoded.fill(0);
    throw new Error("secret_encryption_key_invalid");
  }
  installedKey?.fill(0);
  installedKey = decoded;
}

// legacy：USERNAME/HOME 拼接种子对持有密文文件者可离线推导（#617），仅用于
// 读取存量密文与无宿主注入时的兜底；desktop 生产路径恒走 installSecretEncryptionKey。
function getLegacyKey(): Buffer {
  const seed = process.env.LUME_SECRET_SEED ?? `${process.env.USERNAME ?? "user"}::${process.env.HOME ?? "home"}::lume`;
  return createHash("sha256").update(seed).digest();
}

// v2 密钥解析：RPC 注入的随机 key 优先。LUME_SECRET_SEED 仅在无宿主注入时
// 生效（sidecar 裸跑/CI）；desktop 宿主恒注入，env 无法覆盖随机 key——需要
// 跨机可推导密文的部署应走不注入的宿主形态。
function getV2Key(): Buffer | undefined {
  if (installedKey) return installedKey;
  if (process.env.LUME_SECRET_SEED) return createHash("sha256").update(process.env.LUME_SECRET_SEED).digest();
  return undefined;
}

function requireV2Key(): Buffer {
  const key = getV2Key();
  // 指引 standalone 形态的恢复路径（#617 review）：v2 密文绑定 desktop 注入
  // 的随机密钥，裸跑 sidecar 无宿主注入时需显式提供种子或经 Lume 启动
  if (!key) throw new Error("secret_encryption_locked: v2 secrets require the desktop-injected encryption key; launch via Lume desktop or set LUME_SECRET_SEED");
  return key;
}

function seal(key: Buffer, plainSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(AES_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainSecret, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

function unseal(key: Buffer, payload: Buffer): string {
  // 与 connection-credential-store 的记录守卫对齐：短 payload 抛类型化错误
  if (payload.length < 29) throw new Error("secret_encryption_record_invalid");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = createDecipheriv(AES_ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function encryptSecret(plainSecret: string): string {
  const key = getV2Key();
  // 无注入且无显式覆盖时保持 legacy 行为（开发/CI 场景），不阻塞功能
  if (!key) return seal(getLegacyKey(), plainSecret);
  return V2_PREFIX + seal(key, plainSecret);
}

export function decryptSecret(encryptedSecret: string): string {
  if (encryptedSecret.startsWith(V2_PREFIX)) {
    return unseal(requireV2Key(), Buffer.from(encryptedSecret.slice(V2_PREFIX.length), "base64"));
  }
  return unseal(getLegacyKey(), Buffer.from(encryptedSecret, "base64"));
}
