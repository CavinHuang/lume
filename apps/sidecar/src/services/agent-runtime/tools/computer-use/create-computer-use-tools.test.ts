import { describe, expect, test } from "bun:test";
import { createComputerUseMcpTools } from "./create-computer-use-tools";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { submitDesktopActionDecision } from "../../interruption/desktop-action-session";

const WECHAT = { id: 42, app: "微信", title: "小树懒" };
const HISTORICAL_WECHAT = { id: 42, app: "Weixin.exe", title: "小树懒" };
const CANONICAL_WECHAT = {
  id: 42,
  app: "D:\\software\\Tencent\\Weixin\\Weixin.exe",
  title: "小树懒",
};

function toolByName(tools: ReturnType<typeof createComputerUseMcpTools>, name: string) {
  return tools.find((tool) => tool.name === `mcp__computer_use__${name}`)!;
}

function jsonResult(value: Awaited<ReturnType<ReturnType<typeof createComputerUseMcpTools>[number]["call"]>>) {
  return JSON.parse(value.content as string) as Record<string, unknown>;
}

describe("createComputerUseMcpTools Window2 v3", () => {
  test("publishes exactly the Codex Window2 tools", () => {
    const tools = createComputerUseMcpTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "mcp__computer_use__list_windows",
      "mcp__computer_use__get_window",
      "mcp__computer_use__list_apps",
      "mcp__computer_use__launch_app",
      "mcp__computer_use__get_window_state",
      "mcp__computer_use__click",
      "mcp__computer_use__press_key",
      "mcp__computer_use__type_text",
      "mcp__computer_use__scroll",
      "mcp__computer_use__set_value",
      "mcp__computer_use__drag",
      "mcp__computer_use__perform_secondary_action",
      "mcp__computer_use__activate_window",
    ]);
  });

  test("matches the Codex Window2 input parameter names", () => {
    const tools = createComputerUseMcpTools();
    for (const name of ["get_window_state", "activate_window", "click", "type_text"]) {
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
      expect(schema.properties.stateId).toBeUndefined();
      expect(schema.properties.targetLabel).toBeUndefined();
      expect(schema.properties.recipient).toBeUndefined();
    }
    const listWindows = toolByName(tools, "list_windows").inputSchema as Record<string, any>;
    expect(listWindows.properties).toEqual({});
    const getWindow = toolByName(tools, "get_window").inputSchema as Record<string, any>;
    expect(getWindow.required).toEqual(["id"]);
    expect(getWindow.properties.window).toBeUndefined();
    expect(getWindow.properties).toMatchObject({ id: { type: "integer" }, app: { type: "string" } });
    const click = toolByName(tools, "click").inputSchema as Record<string, any>;
    expect(click.properties.element_index).toMatchObject({ type: "integer", minimum: 0 });
    expect(click.properties.click_count).toBeDefined();
    expect(click.properties.mouse_button).toBeDefined();
    expect(click.properties.clickCount).toBeUndefined();
    expect(click.properties.mouseButton).toBeUndefined();
    expect(click.oneOf).toEqual([
      {
        required: ["element_index"],
        not: { anyOf: [{ required: ["x"] }, { required: ["y"] }] },
      },
      {
        required: ["x", "y"],
        not: { required: ["element_index"] },
      },
    ]);
    expect(click.anyOf).toBeUndefined();
    expect(click.properties.x.description).toContain("window-relative");
    const scroll = toolByName(tools, "scroll").inputSchema as Record<string, any>;
    expect(scroll.required).toEqual(["window", "x", "y", "scrollX", "scrollY"]);
    expect(scroll.properties.direction).toBeUndefined();
    expect(scroll.properties.pages).toBeUndefined();
    const drag = toolByName(tools, "drag").inputSchema as Record<string, any>;
    expect(drag.required).toEqual(["window", "from_x", "from_y", "to_x", "to_y"]);
    expect(drag.properties.fromX).toBeUndefined();
    const pressKey = toolByName(tools, "press_key").inputSchema as Record<string, any>;
    expect(pressKey.required).toEqual(["window", "key"]);
    expect(pressKey.properties.keys).toBeUndefined();
  });

  test("defaults to screenshot observation without accessibility text", async () => {
    const calls: unknown[] = [];
    const tools = createComputerUseMcpTools({
      invoke: async (method, args) => {
        calls.push({ method, args });
        return {
          window: WECHAT,
          accessibility: null,
          screenshots: [],
        };
      },
    });
    const result = await toolByName(tools, "get_window_state").call(
      { window: WECHAT },
      { toolUseId: "state" } as never,
    );
    expect(calls).toEqual([{
      method: "get_window_state",
      args: { window: WECHAT, include_screenshot: true, include_text: false },
    }]);
    expect(jsonResult(result)).toEqual({ window: WECHAT, accessibility: null, screenshots: [] });
  });

  test("reuses the canonical Window returned by observation when the model repeats a legacy app", async () => {
    const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
    const tools = createComputerUseMcpTools({
      threadId: "thread-canonical-window",
      invoke: async (method, args) => {
        calls.push({ method, args });
        if (method === "get_window_state") {
          return { window: CANONICAL_WECHAT, accessibility: null, screenshots: [] };
        }
        return method === "desktop_context.preflight_action" ? {} : null;
      },
    });

    await toolByName(tools, "get_window_state").call(
      { window: HISTORICAL_WECHAT, include_screenshot: false },
      { toolUseId: "canonical-state" } as never,
    );
    const result = await toolByName(tools, "click").call(
      { window: HISTORICAL_WECHAT, x: 518, y: 833 },
      { toolUseId: "canonical-click" } as never,
    );

    expect(calls.slice(1)).toEqual([
      {
        method: "desktop_context.preflight_action",
        args: { action: "click", window: CANONICAL_WECHAT, x: 518, y: 833 },
      },
      { method: "click", args: { window: CANONICAL_WECHAT, x: 518, y: 833 } },
    ]);
    expect((result as any)._meta.computerUseAction.window).toEqual(CANONICAL_WECHAT);
  });

  test("learns canonical windows from every successful Window2 read result", async () => {
    const readCases = [
      { name: "list_windows", args: {}, result: [CANONICAL_WECHAT] },
      {
        name: "list_apps",
        args: {},
        result: [{ id: CANONICAL_WECHAT.app, windows: [CANONICAL_WECHAT] }],
      },
      {
        name: "get_window",
        args: { id: 42, app: HISTORICAL_WECHAT.app },
        result: CANONICAL_WECHAT,
      },
      {
        name: "get_window_state",
        args: { window: HISTORICAL_WECHAT, include_screenshot: false },
        result: { window: CANONICAL_WECHAT, accessibility: null, screenshots: [] },
      },
    ] as const;

    for (const read of readCases) {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const tools = createComputerUseMcpTools({
        invoke: async (method, args) => {
          calls.push({ method, args });
          if (method === read.name) return read.result;
          return method === "desktop_context.preflight_action" ? {} : null;
        },
      });
      await toolByName(tools, read.name).call(
        read.args,
        { toolUseId: `read-${read.name}` } as never,
      );
      await toolByName(tools, "click").call(
        { window: HISTORICAL_WECHAT, x: 10, y: 20 },
        { toolUseId: `click-${read.name}` } as never,
      );

      expect(calls.find((call) => call.method === "desktop_context.preflight_action")?.args.window)
        .toEqual(CANONICAL_WECHAT);
    }
  });

  test("rehydrates get_window with the cached canonical app", async () => {
    const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
    const tools = createComputerUseMcpTools({
      invoke: async (method, args) => {
        calls.push({ method, args });
        if (method === "get_window_state") {
          return { window: CANONICAL_WECHAT, accessibility: null, screenshots: [] };
        }
        if (method === "get_window") return CANONICAL_WECHAT;
        return null;
      },
    });
    await toolByName(tools, "get_window_state").call(
      { window: HISTORICAL_WECHAT, include_screenshot: false },
      { toolUseId: "state-before-rehydrate" } as never,
    );
    await toolByName(tools, "get_window").call(
      { id: 42, app: HISTORICAL_WECHAT.app },
      { toolUseId: "rehydrate-canonical" } as never,
    );

    expect(calls.at(-1)).toEqual({
      method: "get_window",
      args: { id: 42, app: CANONICAL_WECHAT.app },
    });
  });

  test("does not learn a canonical identity from model input alone", async () => {
    const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
    const tools = createComputerUseMcpTools({
      invoke: async (method, args) => {
        calls.push({ method, args });
        throw new Error("stale_target: use the latest state.window");
      },
    });
    await toolByName(tools, "click").call(
      { window: HISTORICAL_WECHAT, x: 10, y: 20 },
      { toolUseId: "uncached-click" } as never,
    );

    expect(calls).toEqual([{
      method: "desktop_context.preflight_action",
      args: { action: "click", window: HISTORICAL_WECHAT, x: 10, y: 20 },
    }]);
  });

  test("dispatches each input as one atomic host call and returns public null", async () => {
    const calls: unknown[] = [];
    const tools = createComputerUseMcpTools({
      threadId: "thread-1",
      invoke: async (method, args) => {
        calls.push({ method, args });
        return null;
      },
    });
    const result = await toolByName(tools, "click").call(
      { window: WECHAT, x: 120, y: 80 },
      { toolUseId: "click-1" } as never,
    );
    expect(calls).toEqual([
      { method: "desktop_context.preflight_action", args: { action: "click", window: WECHAT, x: 120, y: 80 } },
      { method: "click", args: { window: WECHAT, x: 120, y: 80 } },
    ]);
    expect(result.content).toBe("null");
    expect((result as any)._meta.computerUseAction).toMatchObject({ action: "click", phase: "dispatched" });
  });

  test("stops stale preflight before confirmation or input dispatch", async () => {
    const previous = process.env.LUME_CONFIG_DIR;
    const configDir = mkdtempSync(join(tmpdir(), "lume-stale-window-"));
    process.env.LUME_CONFIG_DIR = configDir;
    try {
      const calls: string[] = [];
      const requests: unknown[] = [];
      const tools = createComputerUseMcpTools({
        workspaceSlug: "demo",
        threadId: "thread-stale",
        invoke: async (method) => {
          calls.push(method);
          if (method === "desktop_context.preflight_action") {
            throw new Error("stale_target: use the latest state.window");
          }
          return null;
        },
        emitDesktopActionRequest: (request) => requests.push(request),
      });

      const result = await toolByName(tools, "click").call(
        { window: WECHAT, x: 10, y: 10 },
        { toolUseId: "stale-click" } as never,
      );
      expect((result as any).is_error).toBeTrue();
      expect(jsonResult(result).error).toBe("stale_target: use the latest state.window");
      expect(calls).toEqual(["desktop_context.preflight_action"]);
      expect(requests).toEqual([]);

      const ledgerPath = join(
        configDir,
        "agent-workspaces",
        "demo",
        "threads",
        "thread-stale",
        "files",
        "computer-use",
        "action-ledger.jsonl",
      );
      const entries = readFileSync(ledgerPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(entries.map((entry) => entry.phase)).toEqual(["planned", "failed"]);
      expect(entries.at(-1).failureReason).toBe("stale_target: use the latest state.window");
    } finally {
      if (previous === undefined) delete process.env.LUME_CONFIG_DIR;
      else process.env.LUME_CONFIG_DIR = previous;
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("preserves an explicit host action error instead of replacing it with the null contract", async () => {
    const tools = createComputerUseMcpTools({
      threadId: "thread-host-error",
      invoke: async (method) => method === "desktop_context.preflight_action"
        ? {}
        : { status: "stale_target", message: "stale_target: use the latest state.window" },
    });

    const result = await toolByName(tools, "click").call(
      { window: WECHAT, x: 10, y: 10 },
      { toolUseId: "host-error" } as never,
    );
    expect((result as any).is_error).toBeTrue();
    expect(jsonResult(result).error).toBe("stale_target: use the latest state.window");
  });

  test("rejects ambiguous click targets before preflight", async () => {
    const calls: string[] = [];
    const tools = createComputerUseMcpTools({
      invoke: async (method) => {
        calls.push(method);
        return null;
      },
    });
    const result = await toolByName(tools, "click").call(
      { window: WECHAT, element_index: 0, x: 10, y: 10 },
      { toolUseId: "ambiguous-click" } as never,
    );
    expect((result as any).is_error).toBeTrue();
    expect(jsonResult(result).error).toContain("element_index or x/y");
    expect(calls).toEqual([]);
  });

  test("does not pre-observe or use a separate activation RPC before type_text", async () => {
    const calls: unknown[] = [];
    const tools = createComputerUseMcpTools({
      threadId: "thread-1",
      invoke: async (method, args) => {
        calls.push({ method, args });
        return method === "desktop_context.preflight_action" ? {} : null;
      },
    });
    const result = await toolByName(tools, "type_text").call(
      { window: WECHAT, text: "你好" },
      { toolUseId: "type-1" } as never,
    );
    expect(result.content).toBe("null");
    expect(calls).toEqual([
      { method: "desktop_context.preflight_action", args: { action: "type_text", window: WECHAT } },
      { method: "type_text", args: { window: WECHAT, text: "你好" } },
    ]);
  });

  test("advances hidden action facts only on a later explicit observation", async () => {
    let observed = false;
    const tools = createComputerUseMcpTools({
      threadId: "thread-observe",
      invoke: async (method) => {
        if (method === "desktop_context.preflight_action") return {};
        if (method === "type_text") return null;
        if (method === "get_window_state") {
          observed = true;
          return {
            window: WECHAT,
            accessibility: { tree: "0 edit 你好 (focused)" },
            screenshots: [],
          };
        }
        return null;
      },
    });
    const dispatched = await toolByName(tools, "type_text").call(
      { window: WECHAT, text: "你好" },
      { toolUseId: "type-observe" } as never,
    );
    expect(observed).toBeFalse();
    expect((dispatched as any)._meta.computerUseAction.phase).toBe("dispatched");

    const state = await toolByName(tools, "get_window_state").call(
      { window: WECHAT, include_screenshot: false, include_text: true },
      { toolUseId: "observe" } as never,
    );
    expect((state as any)._meta.computerUseAction).toMatchObject({
      action: "type_text",
      phase: "verified",
    });
  });

  test("reports every batched action advanced by one explicit observation", async () => {
    const tools = createComputerUseMcpTools({
      threadId: "thread-batch-observe",
      invoke: async (method) => {
        if (method === "desktop_context.preflight_action") return {};
        if (method === "get_window_state") {
          return { window: WECHAT, accessibility: { tree: "0 edit 批量输入" }, screenshots: [] };
        }
        return null;
      },
    });
    await toolByName(tools, "click").call(
      { window: WECHAT, x: 10, y: 10 },
      { toolUseId: "batch-click" } as never,
    );
    await toolByName(tools, "type_text").call(
      { window: WECHAT, text: "批量输入" },
      { toolUseId: "batch-type" } as never,
    );

    const state = await toolByName(tools, "get_window_state").call(
      { window: WECHAT, include_screenshot: false, include_text: true },
      { toolUseId: "batch-observe" } as never,
    );
    expect((state as any)._meta.computerUseActions).toMatchObject([
      { action: "click", phase: "observed" },
      { action: "type_text", phase: "verified" },
    ]);
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
          window: WECHAT,
          accessibility: null,
          screenshots: [{
            id: "screenshot:42:1:1",
            width: 2,
            height: 1,
            zIndex: 0,
            url: `data:image/png;base64,${Buffer.from("png").toString("base64")}`,
          }],
        }),
        routeScreenshot: async (path) => {
          expect(existsSync(path)).toBeTrue();
          return { status: "image_ready" };
        },
      });
      const result = await toolByName(tools, "get_window_state").call(
        { window: WECHAT, include_screenshot: true },
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
        return method === "desktop_context.preflight_action"
          ? { targetLabel: "发送消息", recipient: "小树懒" }
          : null;
      },
      emitDesktopActionRequest: (request) => {
        requests.push(request);
        expect(calls).toEqual(["desktop_context.preflight_action"]);
        submitDesktopActionDecision({
          threadId: request.threadId,
          requestId: request.requestId,
          decision: "allow_once",
        });
      },
    });
    const result = await toolByName(tools, "click").call(
      { window: WECHAT, x: 10, y: 10 },
      { toolUseId: "send-1" } as never,
    );

    expect(result.content).toBe("null");
    expect(requests[0]).toMatchObject({
      window: WECHAT,
      recipient: "小树懒",
      confirmationCategories: ["send_message"],
    });
    expect(calls).toEqual(["desktop_context.preflight_action", "click"]);
  });

  test("uses only the original user instruction to raise confirmation when preflight has no label", async () => {
    const requests: any[] = [];
    const tools = createComputerUseMcpTools({
      threadId: "thread-original-intent",
      originalUserInstruction: "在微信回复一句你好",
      invoke: async (method) => method === "desktop_context.preflight_action" ? {} : null,
      emitDesktopActionRequest: (request) => {
        requests.push(request);
        submitDesktopActionDecision({
          threadId: request.threadId,
          requestId: request.requestId,
          decision: "allow_once",
        });
      },
    });

    const result = await toolByName(tools, "press_key").call(
      { window: WECHAT, key: "Return" },
      { toolUseId: "original-intent-send" } as never,
    );

    expect(result.content).toBe("null");
    expect(requests).toHaveLength(1);
    expect(requests[0].confirmationCategories).toContain("send_message");
    expect(requests[0].targetLabel).toBeUndefined();
  });

  test("does not confirm harmless navigation just because the overall task is consequential", async () => {
    const requests: any[] = [];
    const tools = createComputerUseMcpTools({
      threadId: "thread-navigation",
      originalUserInstruction: "删除这条消息",
      invoke: async (method) => method === "desktop_context.preflight_action" ? {} : null,
      emitDesktopActionRequest: (request) => requests.push(request),
    });

    const result = await toolByName(tools, "activate_window").call(
      { window: WECHAT },
      { toolUseId: "activate-for-delete" } as never,
    );

    expect(result.content).toBe("null");
    expect(requests).toEqual([]);
  });

  test("verifies a confirmed submit only after a later observation changes the interface", async () => {
    let state = "0 edit 你好";
    const tools = createComputerUseMcpTools({
      threadId: "thread-submit-observation",
      originalUserInstruction: "把这条消息发送出去",
      invoke: async (method) => {
        if (method === "desktop_context.preflight_action") return {};
        if (method === "press_key") return null;
        if (method === "get_window_state") {
          return {
            window: WECHAT,
            accessibility: { tree: state },
            screenshots: [],
          };
        }
        return null;
      },
      emitDesktopActionRequest: (request) => {
        submitDesktopActionDecision({
          threadId: request.threadId,
          requestId: request.requestId,
          decision: "allow_once",
        });
      },
    });

    await toolByName(tools, "get_window_state").call(
      { window: WECHAT, include_screenshot: false, include_text: true },
      { toolUseId: "submit-before" } as never,
    );
    const dispatched = await toolByName(tools, "press_key").call(
      { window: WECHAT, key: "Return" },
      { toolUseId: "submit-key" } as never,
    );
    expect((dispatched as any)._meta.computerUseAction.phase).toBe("dispatched");

    state = "0 listitem 你好 1 edit";
    const observed = await toolByName(tools, "get_window_state").call(
      { window: WECHAT, include_screenshot: false, include_text: true },
      { toolUseId: "submit-after" } as never,
    );
    expect((observed as any)._meta.computerUseAction).toMatchObject({
      action: "press_key",
      phase: "verified",
    });
  });

  test("requires user takeover for password-change submission", async () => {
    const calls: string[] = [];
    const tools = createComputerUseMcpTools({
      threadId: "thread-password-change",
      originalUserInstruction: "修改密码并提交",
      invoke: async (method) => {
        calls.push(method);
        return method === "desktop_context.preflight_action"
          ? { targetLabel: "保存新密码" }
          : null;
      },
      emitDesktopActionRequest: () => {
        throw new Error("takeover actions must not offer an allow button");
      },
    });

    const result = await toolByName(tools, "click").call(
      { window: WECHAT, x: 10, y: 10 },
      { toolUseId: "password-submit" } as never,
    );

    expect((result as any).is_error).toBeTrue();
    expect(jsonResult(result).error).toContain("user_takeover_required");
    expect(calls).toEqual(["desktop_context.preflight_action"]);
  });
});
