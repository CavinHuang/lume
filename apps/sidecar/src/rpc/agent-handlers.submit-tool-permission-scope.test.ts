import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { submitToolPermissionInputSchema } from "./schemas";

// #558 review P0 钉:allowAlwaysScope 必须穿过 zod schema 与 handler 显式重建
// 两道丢弃点到达 submitAgentToolPermission——此前 command/tool 两档在生产路径
// 上不存在(UI 三选一形同虚设且回执 toast 撒谎),而进程内测试全绿。
// handler 层走 source-content 断言(agent-handlers 对 agent-service 的全量
// 具名导入使整模块 mock 需枚举几十个导出,脆弱;参照 runtime-event-boundary 模式)。
const here = dirname(fileURLToPath(import.meta.url));

function sidecarSource(relPath: string): string {
  return readFileSync(join(here, "..", relPath), "utf-8");
}

describe("submit-tool-permission allowAlwaysScope 穿透(#558 review P0)", () => {
  test("zod schema 不剥 allowAlwaysScope 字段", () => {
    const parsed = submitToolPermissionInputSchema.parse({
      threadId: "thread-1",
      requestId: "req-1",
      decision: "allow_always",
      allowAlwaysScope: "command",
    });
    expect(parsed.allowAlwaysScope).toBe("command");
  });

  test("schema 缺省时 allowAlwaysScope 为 undefined(exact 兼容旧客户端)", () => {
    const parsed = submitToolPermissionInputSchema.parse({
      threadId: "thread-1",
      requestId: "req-1",
      decision: "allow_once",
    });
    expect(parsed.allowAlwaysScope).toBeUndefined();
  });

  test("schema 声明了 allowAlwaysScope 枚举档位", () => {
    const content = sidecarSource("rpc/schemas.ts");
    expect(content).toContain('allowAlwaysScope: z.enum(["exact", "command", "tool"])');
  });

  test("handler 显式重建必须透传 allowAlwaysScope(不得被二次丢弃)", () => {
    const content = sidecarSource("rpc/agent-handlers.ts");
    expect(content).toContain("allowAlwaysScope: input.allowAlwaysScope");
  });
});
