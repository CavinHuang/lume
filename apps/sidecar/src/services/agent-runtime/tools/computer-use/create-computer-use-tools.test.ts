import { describe, expect, test } from "bun:test";
import { createComputerUseMcpTools } from "./create-computer-use-tools";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { submitDesktopActionDecision } from "../../interruption/desktop-action-session";

const WECHAT = { id: 42, app: "微信", title: "小树懒" };

function toolByName(tools: ReturnType<typeof createComputerUseMcpTools>, name: string) {
  return tools.find((tool) => tool.name === `mcp__computer_use__${name}`)!;
}

function jsonResult(value: Awaited<ReturnType<ReturnType<typeof createComputerUseMcpTools>[number]["call"]>>) {
  return JSON.parse(value.content as string) as Record<string, unknown>;
}

describe("createComputerUseMcpTools v2", () => {
  test("publishes only the canonical tools plus explicit screenshot fallback", () => {
    const tools = createComputerUseMcpTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "mcp__computer_use__list_apps",
      "mcp__computer_use__list_windows",
      "mcp__computer_use__get_window",
      "mcp__computer_use__get_window_state",
      "mcp__computer_use__take_screenshot",
      "mcp__computer_use__launch_app",
      "mcp__computer_use__activate_window",
      "mcp__computer_use__click",
      "mcp__computer_use__press_key",
      "mcp__computer_use__type_text",
      "mcp__computer_use__scroll",
      "mcp__computer_use__set_value",
      "mcp__computer_use__drag",
      "mcp__computer_use__perform_secondary_action",
    ]);
  });

  test("accepts one canonical Window and rejects legacy targeting fields", () => {
    const tools = createComputerUseMcpTools();
    for (const name of ["get_window", "get_window_state", "take_screenshot", "activate_window", "click", "type_text"]) {
      const schema = toolByName(tools, name).inputSchema as Record<string, any>;
      expect(schema.required).toContain("window");
      expect(schema.properties.window).toMatchObject({
        type: "object",
        required: ["id", "app"],
        additionalProperties: false,
      });
      expect(schema.properties.windowId).toBeUndefined();
      expect(schema.properties.appId).toBeUndefined();
      expect(schema.properties.elementId).toBeUndefined();
    }
    const click = toolByName(tools, "click").inputSchema as Record<string, any>;
    expect(click.properties.element_index).toMatchObject({ type: "integer", minimum: 0 });
    expect(click.anyOf).toContainEqual({ required: ["stateId", "element_index"] });
    expect(click.properties.x.description).toContain("window-relative");
  });

  test("observes accessibility state without requesting pixels", async () => {
    const calls: unknown[] = [];
    const tools = createComputerUseMcpTools({
      invoke: async (method, args) => {
        calls.push({ method, args });
        return {
          status: "ok",
          stateId: "state-1",
          window: WECHAT,
          focused: true,
          capturedAt: 1,
          accessibility: { tree: [], document_text: "真实聊天" },
        };
      },
    });
    const result = await toolByName(tools, "get_window_state").call(
      { window: WECHAT },
      { toolUseId: "state" } as never,
    );
    expect(calls).toEqual([{ method: "get_window_state", args: { window: WECHAT, include_text: true } }]);
    expect(jsonResult(result).stateId).toBe("state-1");
  });

  test("auto-activates inputs and reports dispatch rather than success", async () => {
    const calls: unknown[] = [];
    const tools = createComputerUseMcpTools({
      threadId: "thread-1",
      invoke: async (method, args) => {
        calls.push({ method, args });
        if (method === "activate_window") return { status: "ok", window: WECHAT };
        return { status: "ok" };
      },
    });
    const result = await toolByName(tools, "click").call(
      { window: WECHAT, x: 120, y: 80 },
      { toolUseId: "click-1" } as never,
    );
    expect(calls).toEqual([
      { method: "activate_window", args: { window: WECHAT } },
      { method: "click", args: { window: WECHAT, x: 120, y: 80 } },
      { method: "get_window_state", args: { window: WECHAT, include_text: true } },
    ]);
    expect(jsonResult(result)).toMatchObject({ status: "dispatched" });
    expect(jsonResult(result).actionId).toBeString();
  });

  test("blocks type_text without editable focus or a real same-window focus event", async () => {
    const calls: unknown[] = [];
    const tools = createComputerUseMcpTools({
      threadId: "thread-1",
      invoke: async (method, args) => {
        calls.push({ method, args });
        return {
          status: "ok",
          stateId: "state-1",
          window: WECHAT,
          focused: true,
          capturedAt: 1,
          accessibility: { tree: [], focused_element: { element_index: 3, role: "text", editable: false } },
        };
      },
    });
    const result = await toolByName(tools, "type_text").call(
      { window: WECHAT, text: "不会发送" },
      { toolUseId: "type-1" } as never,
    );
    expect(jsonResult(result)).toMatchObject({ status: "blocked" });
    expect(calls).toEqual([{ method: "get_window_state", args: { window: WECHAT, include_text: true } }]);
  });

  test("permits type_text after a dispatched click in the same window", async () => {
    const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
    const tools = createComputerUseMcpTools({
      threadId: "thread-1",
      invoke: async (method, args) => {
        calls.push({ method, args });
        if (method === "get_window_state") {
          return {
            status: "ok",
            stateId: "state-2",
            window: WECHAT,
            focused: true,
            capturedAt: 2,
            accessibility: { tree: [] },
          };
        }
        return { status: "ok", window: WECHAT };
      },
    });
    await toolByName(tools, "click").call(
      { window: WECHAT, x: 20, y: 20 },
      { toolUseId: "click-2" } as never,
    );
    const result = await toolByName(tools, "type_text").call(
      { window: WECHAT, text: "你好" },
      { toolUseId: "type-2" } as never,
    );
    expect(jsonResult(result)).toMatchObject({ status: "dispatched" });
    expect(calls).toContainEqual({ method: "type_text", args: { window: WECHAT, text: "你好" } });
    expect(calls.at(-1)).toEqual({ method: "get_window_state", args: { window: WECHAT, include_text: true } });
  });

  test("returns a file reference for one verified vision request without persisting base64", async () => {
    const previous = process.env.LUME_CONFIG_DIR;
    const configDir = mkdtempSync(join(tmpdir(), "lume-vision-shot-"));
    process.env.LUME_CONFIG_DIR = configDir;
    try {
      const tools = createComputerUseMcpTools({
        workspaceSlug: "demo",
        threadId: "thread-1",
        invoke: async () => ({
          status: "ok",
          window: WECHAT,
          screenshots: [{
            id: "screenshot:42:1:1",
            mimeType: "image/png",
            width: 2,
            height: 1,
            dataUrl: `data:image/png;base64,${Buffer.from("png").toString("base64")}`,
          }],
        }),
        routeScreenshot: async (path) => {
          expect(existsSync(path)).toBeTrue();
          return { status: "image_ready" };
        },
      });
      const result = await toolByName(tools, "take_screenshot").call(
        { window: WECHAT },
        { toolUseId: "shot-1" } as never,
      );
      expect(Array.isArray(result.content)).toBeTrue();
      expect(JSON.stringify(result.content)).not.toContain(Buffer.from("png").toString("base64"));
      expect((result.content as any[])[1]).toMatchObject({
        type: "image",
        source: { type: "file", media_type: "image/png" },
        _meta: { persist: false, screenshotId: "screenshot:42:1:1" },
      });
    } finally {
      if (previous === undefined) delete process.env.LUME_CONFIG_DIR;
      else process.env.LUME_CONFIG_DIR = previous;
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("confirms sending at action time with target and data classification", async () => {
    const calls: string[] = [];
    const requests: any[] = [];
    const tools = createComputerUseMcpTools({
      threadId: "thread-send",
      invoke: async (method) => {
        calls.push(method);
        return method === "get_window_state"
          ? { status: "ok", stateId: "after", window: WECHAT, focused: true, accessibility: { tree: [] } }
          : { status: "ok" };
      },
      emitDesktopActionRequest: (request) => {
        requests.push(request);
        expect(calls).toEqual([]);
        submitDesktopActionDecision({
          threadId: request.threadId,
          requestId: request.requestId,
          decision: "allow_once",
        });
      },
    });
    const result = await toolByName(tools, "click").call({
      window: WECHAT,
      x: 10,
      y: 10,
      targetLabel: "发送消息",
      recipient: "小树懒",
    }, { toolUseId: "send-1" } as never);

    expect(jsonResult(result).status).toBe("dispatched");
    expect(requests[0]).toMatchObject({
      window: WECHAT,
      recipient: "小树懒",
      confirmationCategories: ["send_message"],
    });
    expect(calls).toEqual(["activate_window", "click", "get_window_state"]);
  });
});
