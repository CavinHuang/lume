import { describe, expect, test } from "bun:test";
import { resolveEnabledPiMemoryToolNames } from "./tool-policy";

describe("tool-policy", () => {
  test("应按 memory policy 返回启用工具", () => {
    const tools = resolveEnabledPiMemoryToolNames({
      allow: ["memory_search", "memory_get"],
      deny: ["memory_get"]
    });
    expect(tools).toEqual(["memory_search"]);
  });
});
