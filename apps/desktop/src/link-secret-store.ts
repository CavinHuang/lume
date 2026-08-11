import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface EncryptedLinkSecrets { version: 1; iv: string; ciphertext: string; tag: string }
export interface LinkRuntimeSecrets { encryptionKey: string; adminToken: string; runtimeToken: string }
export interface LinkRemoteCredentials { origin: string; adminToken: string; runtimeToken: string }

export function loadOrCreateLinkSecrets(path: string, masterKey: Buffer): LinkRuntimeSecrets {
  if (masterKey.length !== 32) throw new Error("connection_vault_locked");
  if (existsSync(path)) return decryptLinkSecrets(JSON.parse(readFileSync(path, "utf8")), masterKey);
  const secrets: LinkRuntimeSecrets = {
    encryptionKey: randomBytes(32).toString("base64url"),
    adminToken: randomBytes(32).toString("base64url"),
    runtimeToken: randomBytes(32).toString("base64url"),
  };
  const record = encryptLinkSecrets(secrets, masterKey);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
  return secrets;
}

export function encryptLinkSecrets(secrets: LinkRuntimeSecrets, masterKey: Buffer): EncryptedLinkSecrets {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  cipher.setAAD(Buffer.from("lume-link-runtime-secrets:v1"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secrets)), cipher.final()]);
  return { version: 1, iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export function decryptLinkSecrets(record: EncryptedLinkSecrets, masterKey: Buffer): LinkRuntimeSecrets {
  if (record?.version !== 1) throw new Error("unsupported_link_secret_record");
  const decipher = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(record.iv, "base64"));
  decipher.setAAD(Buffer.from("lume-link-runtime-secrets:v1"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8"));
  if (!value?.encryptionKey || !value?.adminToken || !value?.runtimeToken) throw new Error("invalid_link_secret_record");
  return value;
}

export function loadLinkRemoteCredentials(path: string, masterKey: Buffer): LinkRemoteCredentials | null {
  if (masterKey.length !== 32) throw new Error("connection_vault_locked");
  if (!existsSync(path)) return null;
  const record = JSON.parse(readFileSync(path, "utf8")) as EncryptedLinkSecrets;
  if (record?.version !== 1) throw new Error("unsupported_link_remote_secret_record");
  const decipher = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(record.iv, "base64"));
  decipher.setAAD(Buffer.from("lume-link-remote-secrets:v1"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8"));
  if (typeof value?.origin !== "string" || typeof value?.adminToken !== "string" || typeof value?.runtimeToken !== "string") {
    throw new Error("invalid_link_remote_secret_record");
  }
  return value;
}

export function saveLinkRemoteCredentials(path: string, credentials: LinkRemoteCredentials, masterKey: Buffer): void {
  if (masterKey.length !== 32) throw new Error("connection_vault_locked");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  cipher.setAAD(Buffer.from("lume-link-remote-secrets:v1"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials)), cipher.final()]);
  const record: EncryptedLinkSecrets = {
    version: 1,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}
