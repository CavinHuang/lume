import { describe, expect, test } from "bun:test";
import { decryptSecret, decryptSecretIfEncrypted, encryptSecret, installSecretEncryptionKey } from "./secret-crypto";

// 未注入时走 legacy 弱种子路径——这条密文供"注入后仍可读存量"用例复用
const legacyCiphertext = encryptSecret("legacy-secret");

describe("secret-crypto", () => {
  // 必须先于一切注入执行：模拟 standalone/未注钥形态读到 desktop 写入的 v2 密文
  test("v2 ciphertexts fail typed when no key is installed (standalone sidecar)", () => {
    expect(() => decryptSecret(`enc:v2:${Buffer.alloc(48, 7).toString("base64")}`)).toThrow(
      "secret_encryption_locked",
    );
  });

  test("encryptSecret round-trips without returning plaintext (legacy fallback)", () => {
    expect(legacyCiphertext).not.toContain("enc:v2:");
    expect(decryptSecret(legacyCiphertext)).toBe("legacy-secret");
  });

  test("round-trips without returning plaintext", () => {
    const encrypted = encryptSecret("secret-value");

    expect(encrypted).not.toBe("secret-value");
    expect(decryptSecret(encrypted)).toBe("secret-value");
  });

  test("installed key upgrades new ciphertexts to the v2 envelope", () => {
    installSecretEncryptionKey(Buffer.alloc(32, 42).toString("base64"));

    const encrypted = encryptSecret("secret-value");

    expect(encrypted.startsWith("enc:v2:")).toBe(true);
    expect(decryptSecret(encrypted)).toBe("secret-value");
  });

  test("legacy ciphertexts stay readable after the installed key arrives", () => {
    // 存量密文无版本前缀，继续按 legacy 种子解；无自动迁移——仅重录明文才以 v2 落盘
    expect(decryptSecret(legacyCiphertext)).toBe("legacy-secret");
  });

  test("short v2 payloads are rejected with a typed error", () => {
    installSecretEncryptionKey(Buffer.alloc(32, 42).toString("base64"));
    expect(() => decryptSecret("enc:v2:AAAA")).toThrow("secret_encryption_record_invalid");
  });

  test("rejects keys that are not 32 bytes", () => {
    expect(() => installSecretEncryptionKey(Buffer.alloc(16, 1).toString("base64"))).toThrow(
      "secret_encryption_key_invalid",
    );
    expect(() => installSecretEncryptionKey(undefined)).toThrow("secret_encryption_key_invalid");
  });

  test("v2 ciphertexts fail to decrypt under a different installed key", () => {
    const encrypted = encryptSecret("bound-to-first-key");
    installSecretEncryptionKey(Buffer.alloc(32, 43).toString("base64"));

    // GCM tag 校验失败必须抛错，而不是返回垃圾明文
    expect(() => decryptSecret(encrypted)).toThrow();
  });

  test("decryptSecretIfEncrypted passes plaintext through (#598 legacy sessionWebhook)", () => {
    // 存量钉钉 binding 的 contextToken 是从未加密过的明文 webhook，无前缀透传
    const webhook = "https://oapi.dingtalk.com/robot/sendBySession?access_token=legacy-plain";
    expect(decryptSecretIfEncrypted(webhook)).toBe(webhook);
    expect(decryptSecretIfEncrypted(undefined)).toBeUndefined();
  });

  test("decryptSecretIfEncrypted unwraps v2 ciphertext and still fails closed on corrupt records", () => {
    installSecretEncryptionKey(Buffer.alloc(32, 42).toString("base64"));
    const encrypted = encryptSecret("sealed-webhook");
    expect(decryptSecretIfEncrypted(encrypted)).toBe("sealed-webhook");
    // 带 enc: 前缀但内容损坏 → 抛错而不是当明文透传
    expect(() => decryptSecretIfEncrypted(`enc:v2:${Buffer.alloc(48, 9).toString("base64")}`)).toThrow();
  });
});
