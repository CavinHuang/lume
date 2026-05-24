import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const AES_ALGO = "aes-256-gcm";

function getEncryptionKey(): Buffer {
  const seed = process.env.LUME_SECRET_SEED ?? `${process.env.USERNAME ?? "user"}::${process.env.HOME ?? "home"}::lume`;
  return createHash("sha256").update(seed).digest();
}

export function encryptSecret(plainSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(AES_ALGO, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainSecret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptSecret(encryptedSecret: string): string {
  const data = Buffer.from(encryptedSecret, "base64");
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = createDecipheriv(AES_ALGO, getEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
