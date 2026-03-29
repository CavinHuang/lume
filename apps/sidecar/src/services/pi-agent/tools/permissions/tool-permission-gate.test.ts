import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { wrapToolsWithPermissionGate } from "./tool-permission-gate";

function createReadTool(): AgentTool {
  return {
    name: "read",
    label: "read",
    description: "read file",
    parameters: {},
    async execute() {
      return {
        content: [{ type: "text", text: "ok" }],
        details: { ok: true }
      };
    }
  } as unknown as AgentTool;
}

describe("tool-permission-gate memory read guard", () => {
  test("应拒绝 read 直接读取 MEMORY.md，提示改用 memory_get", async () => {
    const [tool] = wrapToolsWithPermissionGate([createReadTool()], {
      sessionId: "s1",
      permissionMode: "default",
      emitToolPermissionRequest: () => {}
    });
    if (!tool?.execute) throw new Error("tool execute 不存在");

    await expect(
      tool.execute("call-1", { path: "MEMORY.md" }, new AbortController().signal)
    ).rejects.toThrow("memory_get");
  });

  test("应允许 read 读取普通文件", async () => {
    const [tool] = wrapToolsWithPermissionGate([createReadTool()], {
      sessionId: "s1",
      permissionMode: "default",
      emitToolPermissionRequest: () => {}
    });
    if (!tool?.execute) throw new Error("tool execute 不存在");

    const result = await tool.execute(
      "call-2",
      { path: "SOUL.md" },
      new AbortController().signal
    );

    expect(result?.content?.[0]?.type).toBe("text");
  });
});
