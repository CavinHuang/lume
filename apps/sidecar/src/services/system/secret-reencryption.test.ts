import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateLegacySecretCiphertexts } from "./secret-reencryption-service";
import { installSecretEncryptionKey } from "../infra/secret-crypto";
import { getImConfigPath } from "../infra/config-paths";

// #793① 行为断言:PR#741 的源码文本断言(同名分支唯一性)监听不到运行时回归——
// 此处以真实 im.json 落盘驱动 migrateLegacySecretCiphertexts,钉死两条行为:
// legacy 密文迁移为 v2;重复执行幂等(v2 前缀跳过,密文原样)。该链路曾有双分支
// 缺陷整个存活期 CI 全绿的记录(#783)。

// LUME_SECRET_SEED 固定:legacy 密文离线手工构造,不依赖模块级 installedKey 时序
// (secret-crypto 的 getLegacyKey 优先读该 env)
const SEED = "reencryption-test-seed";

function legacySeal(plain: string): string {
  const key = createHash("sha256").update(SEED).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

describe("migrateLegacySecretCiphertexts", () => {
  test("legacy 密文迁移为 v2;重复执行幂等(v2 前缀跳过)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-reencrypt-"));
    const previousDir = process.env.LUME_CONFIG_DIR;
    const previousSeed = process.env.LUME_SECRET_SEED;
    process.env.LUME_CONFIG_DIR = dir;
    process.env.LUME_SECRET_SEED = SEED;
    try {
      writeFileSync(
        getImConfigPath(),
        JSON.stringify({
          version: 1,
          accounts: [
            { id: "acc-1", provider: "qq", accountKey: "k1", label: "t", uin: "1", workspaceId: "w1", encryptedToken: legacySeal("token-plain") },
          ],
        }),
      );
      installSecretEncryptionKey(Buffer.alloc(32, 9).toString("base64"));

      const first = await migrateLegacySecretCiphertexts();
      expect(first.imTokens).toBe(1);
      const stored = JSON.parse(readFileSync(getImConfigPath(), "utf-8")) as { accounts: Array<{ encryptedToken: string }> };
      expect(stored.accounts[0]!.encryptedToken.startsWith("enc:v2:")).toBe(true);

      // 幂等:第二次迁移 v2 前缀跳过——计数归零且密文原样(不得二次加密)
      const second = await migrateLegacySecretCiphertexts();
      expect(second.imTokens).toBe(0);
      expect((JSON.parse(readFileSync(getImConfigPath(), "utf-8")) as typeof stored).accounts[0]!.encryptedToken).toBe(
        stored.accounts[0]!.encryptedToken,
      );
    } finally {
      if (previousDir === undefined) delete process.env.LUME_CONFIG_DIR;
      else process.env.LUME_CONFIG_DIR = previousDir;
      if (previousSeed === undefined) delete process.env.LUME_SECRET_SEED;
      else process.env.LUME_SECRET_SEED = previousSeed;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
