/**
 * handleRpcLine 方法分派表守卫(round5 review P2 补防):
 * system.secret-encryption-key 曾因 #649 三次融合的零冲突自动合并长出两个
 * 连续同名分支,第一个命中即 return 使含 migrateLegacySecretCiphertexts 的
 * 超集分支永不可达(#783),缺陷整个存活期 CI 全绿——现有测试体系对分支
 * 死活完全不敏感。此文件以纯源码文本断言钉住两类回归,不触运行时。
 *
 * 结构契约(round6 review):本守卫假定分派保持扁平
 * `if (method === "...") { … }` 形态;重构为 switch/else-if 链须同步改写本守卫,
 * 届时红测是过期信号而非噪音。另勿在 index.ts 注释中书写 `method === "xxx"`
 * 字样,会被断言一计入判重(round6 P3 提示)。
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
    // 调用形貌锚定而非裸 token 匹配:窗内历史注解含该标识符字面量,
    // toContain 会把"删掉真调用仅剩注释"的回归判成绿(round6 review P1)。
    expect(branch![0]).toMatch(/void\s+migrateLegacySecretCiphertexts\(/);
  });
});
