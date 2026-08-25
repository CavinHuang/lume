import { describe, expect, test } from "bun:test";
import { stableHashPayload } from "./payload-hash";

// #531：写入侧（runtime-core/run.ts checkpoint 持久化）与恢复侧（run.ts 冷启动
// 校验、runner/lume-runner.ts continuation permission handler、interruption 两侧
// session）收敛到同一实现后，本测试用固定输入钉住字面量摘要——若有人更换归一化
// 规则（如 undefined 不再折叠为 null）或改哈希算法，跨文件配对会静默断裂。

describe("stableHashPayload", () => {
  // sha256('{"command":"bun test","timeout":120000,"nested":{"a":[1,2,3]}}')
  const TOOL_INPUT_DIGEST = "d8b0b1a8829c85ef9b434f41d68410e92242256ef3c8514a5d77503ed0a76ea2";

  test("固定输入钉住已知摘要值（sha256(JSON 字面量)）", () => {
    const toolInput = { command: "bun test", timeout: 120_000, nested: { a: [1, 2, 3] } };
    expect(stableHashPayload(toolInput)).toBe(TOOL_INPUT_DIGEST);
    expect(stableHashPayload(toolInput)).toBe(stableHashPayload(toolInput));
  });

  test("undefined 折叠为 null（即 sha256(\"null\")，两处调用点的 ?? null 归一化）", () => {
    expect(stableHashPayload(undefined)).toBe("74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b");
    expect(stableHashPayload({})).not.toBe(stableHashPayload(undefined));
  });

  test("不同输入不得碰撞", () => {
    expect(stableHashPayload({ a: 1 })).not.toBe(stableHashPayload({ a: 2 }));
    expect(stableHashPayload(null)).not.toBe(stableHashPayload("null"));
  });
});
