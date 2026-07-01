import { describe, expect, test } from "bun:test";
import { defineTool } from "./types.js";

describe("defineTool", () => {
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
});
