/**
 * handleRpcLine 方法分派表守卫(round5 review P2 补防):
 * system.secret-encryption-key 曾因 #649 三次融合的零冲突自动合并长出两个
 * 连续同名分支,第一个命中即 return 使含 migrateLegacySecretCiphertexts 的
 * 超集分支永不可达(#783),缺陷整个存活期 CI 全绿——现有测试体系对分支
 * 死活完全不敏感。此文件以纯源码文本断言钉住两类回归,不触运行时。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const source = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");

describe("handleRpcLine 分派表(#783 回归防线)", () => {
  test("同名 method 不得出现多个 if 分支(重复即产生不可达死分支)", () => {
    const conditions = [...source.matchAll(/method === "([^"]+)"/g)].map((m) => m[1]);
    const duplicates = conditions.filter((name, i) => conditions.indexOf(name) !== i);
    expect(duplicates).toEqual([]);
  });

  test("system.secret-encryption-key 分支必须携带 #637 密文升级调用", () => {
    const branch = source.match(/if \(method === "system\.secret-encryption-key"\) \{[\s\S]*?\n  \}/);
    expect(branch).not.toBeNull();
    expect(branch![0]).toContain("migrateLegacySecretCiphertexts");
  });
});
