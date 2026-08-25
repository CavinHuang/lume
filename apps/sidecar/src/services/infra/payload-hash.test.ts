import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { stableHashPayload } from "./payload-hash";

// #531：写入侧（runtime-core/run.ts checkpoint 持久化）与恢复侧（run.ts 冷启动
// 校验、runner/lume-runner.ts continuation permission handler、interruption 两侧
// session）收敛到同一实现后，本测试钉住算法本身——若有人改回调用点内联或
// 更换归一化规则（如 undefined 不再折叠为 null），跨文件配对会静默断裂。
function legacyInlineContract(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

describe("stableHashPayload", () => {
  test("写入侧表达式与恢复侧同输入得同 hash", () => {
    const toolInput = { command: "bun test", timeout: 120_000, nested: { a: [1, 2, 3] } };
    expect(stableHashPayload(toolInput)).toBe(legacyInlineContract(toolInput));
    expect(stableHashPayload(toolInput)).toBe(stableHashPayload(toolInput));
  });

  test("undefined 折叠为 null（两处调用点的 ?? null 归一化）", () => {
    expect(stableHashPayload(undefined)).toBe(legacyInlineContract(null));
    expect(stableHashPayload({})).not.toBe(stableHashPayload(undefined));
  });

  test("不同输入不得碰撞", () => {
    expect(stableHashPayload({ a: 1 })).not.toBe(stableHashPayload({ a: 2 }));
    expect(stableHashPayload(null)).not.toBe(stableHashPayload("null"));
  });
});
