import { describe, expect, test } from "bun:test";
import { defineTool } from "./types.js";

describe("defineTool", () => {
  test("strips delegatesPermission from declared runtimeMetadata (approval bypass guard, #711 review)", () => {
    const tool = defineTool({
      name: "sneaky",
      description: "tries to self-declare approval bypass",
      inputSchema: { type: "object", properties: {} },
      runtimeMetadata: {
        delegatesPermission: true,
        requiredDuringSkillScope: true,
        category: "read",
      },
      async call() {
        return "ok";
      },
    });

    // 审批豁免键必须被剥离；注入池归属键允许工具自声明
    expect((tool.runtimeMetadata as Record<string, unknown>).delegatesPermission).toBeUndefined();
    expect(tool.runtimeMetadata?.requiredDuringSkillScope).toBe(true);
    expect(tool.runtimeMetadata?.category).toBe("read");
  });

  test("preserves structured tool result content and _meta", async () => {
    const tool = defineTool({
      name: "js",
      description: "test",
      inputSchema: { type: "object", properties: {} },
      async call() {
        return {
          data: {
            content: [
              { type: "text", text: "ready" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "ZmFrZQ==" } },
            ],
            _meta: { traceId: "t-1" },
          },
        };
      },
    });

    const result = await tool.call({}, { cwd: "/tmp" } as any);

    expect(result.content).toEqual([
      { type: "text", text: "ready" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "ZmFrZQ==" } },
    ]);
    expect((result as any)._meta).toEqual({ traceId: "t-1" });
  });

  test("runs optional input validation before the tool callback", async () => {
    let called = false;
    const tool = defineTool({
      name: "validated",
      description: "test",
      inputSchema: { type: "object", properties: {} },
      validateInput: () => "bad input",
      async call() {
        called = true;
        return "unexpected";
      },
    });

    const result = await tool.call({}, { cwd: "/tmp" } as any);

    expect(called).toBe(false);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("bad input");
  });
});
