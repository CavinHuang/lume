import { describe, expect, test } from "bun:test";
import {
  convertComputerUseToolResult,
  createComputerUseRequestBridge,
  mergeComputerUseExecutionResult,
  parseComputerUseHostCall,
} from "./node-repl-computer-use-bridge";

describe("node_repl Computer Use bridge", () => {
  test("converts the MCP adapter result into a sky value plus ephemeral attachments", () => {
    const converted = convertComputerUseToolResult({
      type: "tool_result",
      tool_use_id: "tool-1",
      content: [
        { type: "text", text: JSON.stringify({ window: { id: 42, app: "微信" }, screenshots: [] }) },
        {
          type: "image",
          source: { type: "file", path: "files/computer-use/shot.png", media_type: "image/png" },
          _meta: { persist: false },
        },
        {
          type: "text",
          text: "[Untrusted visual observation]",
          _meta: { contextBlock: "computer_use_visual", persist: false, screenshotId: "shot-1" },
        },
      ] as any,
      _meta: { computerUseAction: { actionId: "action-1" } },
    } as any);

    expect(converted.value).toMatchObject({ window: { id: 42, app: "微信" } });
    expect(converted.content).toHaveLength(2);
    expect(converted.content?.[1]).toMatchObject({
      type: "text",
      _meta: { contextBlock: "computer_use_visual", persist: false, screenshotId: "shot-1" },
    });
    expect(converted.meta).toMatchObject({ computerUseAction: { actionId: "action-1" } });
    expect(() => convertComputerUseToolResult({
      type: "tool_result",
      tool_use_id: "tool-2",
      content: JSON.stringify({ error: "desktop host unavailable" }),
      is_error: true,
    } as any)).toThrow("desktop host unavailable");
  });

  test("accepts only the canonical Computer Use method allowlist", () => {
    expect(parseComputerUseHostCall({ method: "list_windows", params: {} })).toEqual({
      method: "list_windows",
      params: {},
    });
    expect(() => parseComputerUseHostCall({ method: "desktop_context.preflight_action", params: {} }))
      .toThrow("unsupported Computer Use method");
    expect(() => parseComputerUseHostCall({ method: "click", params: [] }))
      .toThrow("Computer Use params must be an object");
  });

  test("adds ephemeral file images and action metadata to the outer JS result", () => {
    const result = mergeComputerUseExecutionResult(
      { content: [{ type: "text", text: "ready" }], _meta: { traceId: "trace-1" } },
      [{
        value: { window: { id: 42, app: "微信" } },
        content: [{
          type: "image",
          source: { type: "file", path: "files/computer-use/shot.png", media_type: "image/png" },
          _meta: { persist: false },
        }],
        meta: { computerUseSurface: "sky" },
      }],
    );

    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toMatchObject({ type: "image", _meta: { persist: false } });
    expect(result._meta).toEqual({ traceId: "trace-1", computerUseSurface: "sky" });
    expect(JSON.stringify(result)).not.toContain("base64");
  });

  test("preserves every hidden action fact from a batched JavaScript cell", () => {
    const first = { actionId: "action-1", action: "click", phase: "dispatched" };
    const second = { actionId: "action-2", action: "type_text", phase: "dispatched" };
    const result = mergeComputerUseExecutionResult(
      { content: [{ type: "text", text: "done" }] },
      [
        { value: null, meta: { computerUseAction: first } },
        { value: null, meta: { computerUseAction: second } },
      ],
    );

    expect(result._meta?.computerUseAction).toEqual(second);
    expect(result._meta?.computerUseActions).toEqual([first, second]);
  });

  test("routes sky requests through the existing Computer Use tool adapter", async () => {
    let receivedContext: Record<string, unknown> | undefined;
    const request = createComputerUseRequestBridge({
      threadId: "thread-1",
      cwd: "C:/workspace",
      tools: [{
        name: "mcp__computer_use__list_windows",
        description: "",
        inputSchema: { type: "object", properties: {} },
        async call(_input, context) {
          receivedContext = context as unknown as Record<string, unknown>;
          return {
            type: "tool_result",
            tool_use_id: context.toolUseId ?? "",
            content: JSON.stringify([{ id: 42, app: "微信" }]),
          };
        },
      }],
    });
    const abortController = new AbortController();

    await expect(request({ method: "list_windows", params: {} }, abortController.signal))
      .resolves.toEqual({
        value: [{ id: 42, app: "微信" }],
        meta: { computerUseSurface: "sky" },
      });
    expect(receivedContext).toMatchObject({
      sessionId: "thread-1",
      cwd: "C:/workspace",
      abortSignal: abortController.signal,
    });
  });
});
