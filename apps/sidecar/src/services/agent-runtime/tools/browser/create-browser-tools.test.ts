/**
 * 浏览器工具族 → 46 命令协议映射测试:经注入的 fake 后端捕获 buildCommand
 * 产物,钉住工具面与 zod 协议闸的关键映射(tabs/导航/视口/快照/交互/
 * playwright/cua/dom_cua/对话框/录制/可见性)与结果塑形(meta 剥除、
 * 错误折进 tool_result、tabs_new 同调用导航)。
 */
import { describe, expect, test } from "bun:test";

import {
  BROWSER_CAPABILITIES,
  type BrowserCommand,
  type BrowserCommandContext,
  type BrowserCommandResult,
} from "@lume/shared";
import type { ToolDefinition } from "@lume/agent-sdk";

import { createBrowserTools, BROWSER_TOOL_NAMES, type BrowserToolName } from "./create-browser-tools";

type ExecuteFn = (input: {
  context: BrowserCommandContext;
  command: BrowserCommand;
}) => BrowserCommandResult | Promise<BrowserCommandResult>;

function capturingBackend(execute: ExecuteFn) {
  const commands: BrowserCommand[] = [];
  return {
    commands,
    backend: {
      descriptor: {
        id: "iab:test",
        generation: 1,
        type: "iab" as const,
        name: "test",
        capabilities: { browser: BROWSER_CAPABILITIES, tab: [] as [] },
        apiSupportOverrides: [],
        metadata: { provider: "test" },
      },
      async execute(input: { context: BrowserCommandContext; command: BrowserCommand }) {
        commands.push(input.command);
        return await execute(input);
      },
    },
  };
}

function makeTools(execute: ExecuteFn): { tools: ToolDefinition[]; commands: BrowserCommand[] } {
  const { backend, commands } = capturingBackend(execute);
  return { commands, tools: createBrowserTools({ threadId: "thread-1", backend }) };
}

function toolByName(tools: ToolDefinition[], name: BrowserToolName): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === `mcp__browser__${name}`);
  if (!tool) throw new Error(`missing tool: ${name}`);
  return tool;
}

/** 单命令工具:调用一次并返回后端收到的命令。 */
async function mapOne(name: BrowserToolName, args: Record<string, unknown>, backendResult?: ExecuteFn): Promise<BrowserCommand> {
  const { commands, tools } = makeTools(backendResult ?? (() => ({ ok: true })));
  const tool = toolByName(tools, name);
  await tool.call(args, { toolUseId: "tu-1" } as never);
  expect(commands).toHaveLength(1);
  return commands[0]!;
}

describe("工具面与注册形状", () => {
  test("19 个工具,统一 mcp__browser__ 前缀", () => {
    const { tools } = makeTools(() => ({ ok: true }));
    expect(tools).toHaveLength(BROWSER_TOOL_NAMES.length);
    expect(tools.map((tool) => tool.name)).toEqual(BROWSER_TOOL_NAMES.map((name) => `mcp__browser__${name}`));
  });

  test("读类工具标只读且允许 plan mode,写类相反", () => {
    const { tools } = makeTools(() => ({ ok: true }));
    const snapshot = toolByName(tools, "snapshot");
    const navigate = toolByName(tools, "navigate");
    expect(snapshot.isReadOnly?.()).toBe(true);
    expect(navigate.isReadOnly?.()).toBe(false);
    const snapshotMeta = snapshot.runtimeMetadata as Record<string, unknown>;
    expect(snapshotMeta.allowedInPlanMode).toBe(true);
    expect(navigate.runtimeMetadata && (navigate.runtimeMetadata as Record<string, unknown>).allowedInPlanMode).toBe(false);
  });
});

describe("工具 → 命令映射", () => {
  test("tab 生命周期族", async () => {
    expect(await mapOne("tabs_list", {})).toEqual({ method: "list" });
    expect(await mapOne("user_open_tabs", {})).toEqual({ method: "listUserTabs" });
    expect(await mapOne("claim_tab", { tabId: "u1" })).toEqual({ method: "claimTab", tabId: "u1" });
    expect(await mapOne("tabs_new", {})).toEqual({ method: "newTab" });
    expect(await mapOne("tabs_activate", { tabId: "t2" })).toEqual({ method: "activateTab", tabId: "t2" });
    expect(await mapOne("tabs_close", { tabId: "t3" })).toEqual({ method: "close", tabId: "t3" });
    expect(await mapOne("tabs_close", {})).toEqual({ method: "close" });
    expect(await mapOne("tabs_finalize", { keep: [{ tabId: "t1", status: "deliverable" }] })).toEqual({
      method: "finalizeTabs",
      keep: [{ tabId: "t1", status: "deliverable" }],
    });
  });

  test("导航 / 翻页 / 视口族", async () => {
    expect(await mapOne("navigate", { url: "https://example.com/", tabId: "t9" })).toEqual({
      method: "navigate",
      tabId: "t9",
      url: "https://example.com/",
    });
    expect(await mapOne("tab_action", { action: "reload" })).toEqual({ method: "reload" });
    expect(await mapOne("tab_action", { action: "back", tabId: "t1" })).toEqual({ method: "back", tabId: "t1" });
    expect(await mapOne("viewport", { action: "set", width: 1280, height: 720 })).toEqual({
      method: "browserViewportSet",
      width: 1280,
      height: 720,
    });
    expect(await mapOne("viewport", { action: "reset", tabId: "t1" })).toEqual({ method: "browserViewportReset", tabId: "t1" });
  });

  test("观察族:snapshot/screenshot 参数透传", async () => {
    expect(await mapOne("snapshot", { maxElements: 50, includeHidden: true })).toEqual({
      method: "snapshot",
      maxElements: 50,
      includeHidden: true,
    });
    expect(await mapOne("screenshot", { fullPage: true, tabId: "t1" })).toEqual({
      method: "screenshot",
      fullPage: true,
      tabId: "t1",
    });
  });

  test("interact:ref 路径与坐标路径按键类拆分参数", async () => {
    expect(await mapOne("interact", { action: "click", ref: "e12", button: "right", doubleClick: true })).toEqual({
      method: "click",
      ref: "e12",
      button: "right",
      doubleClick: true,
    });
    expect(await mapOne("interact", { action: "click", x: 10, y: 20 })).toEqual({ method: "click", x: 10, y: 20 });
    // fill 无执行器路由(desktop 只路由 type),工具层映射为同构的 type 命令。
    expect(await mapOne("interact", { action: "fill", ref: "e3", text: "hello" })).toEqual({
      method: "type",
      ref: "e3",
      text: "hello",
    });
    expect(await mapOne("interact", { action: "press", ref: "e4", key: "Enter" })).toEqual({
      method: "press",
      ref: "e4",
      key: "Enter",
    });
    expect(await mapOne("interact", { action: "select", ref: "e5", values: ["a", "b"] })).toEqual({
      method: "select",
      ref: "e5",
      values: ["a", "b"],
    });
    expect(await mapOne("interact", { action: "check", ref: "e6", checked: false })).toEqual({
      method: "check",
      ref: "e6",
      checked: false,
    });
    expect(await mapOne("interact", {
      action: "drag",
      fromRef: "e7",
      to: { x: 1, y: 2 },
    })).toEqual({ method: "drag", fromRef: "e7", to: { x: 1, y: 2 } });
  });

  test("playwright / cua / dom_cua 族", async () => {
    expect(await mapOne("playwright", { action: { name: "domSnapshot" }, tabId: "t1" })).toEqual({
      method: "playwright",
      tabId: "t1",
      action: { name: "domSnapshot" },
    });
    expect(await mapOne("playwright", {
      action: { name: "locator", selector: "role=button[name=\"Submit\"]", operation: "click" },
    })).toEqual({
      method: "playwright",
      action: { name: "locator", selector: "role=button[name=\"Submit\"]", operation: "click" },
    });
    expect(await mapOne("cua", { action: "keypress", keys: ["Control+a"] })).toEqual({
      method: "cuaKeypress",
      keys: ["Control+a"],
    });
    expect(await mapOne("cua", { action: "scroll", x: 5, y: 6, scrollX: 0, scrollY: 120 })).toEqual({
      method: "cuaScroll",
      x: 5,
      y: 6,
      scrollX: 0,
      scrollY: 120,
    });
    expect(await mapOne("cua", { action: "drag", path: [{ x: 0, y: 0 }, { x: 9, y: 9 }] })).toEqual({
      method: "cuaDrag",
      path: [{ x: 0, y: 0 }, { x: 9, y: 9 }],
    });
    expect(await mapOne("dom_cua", { nodeId: "e5", scrollX: 0, scrollY: 200 })).toEqual({
      method: "domCuaScroll",
      nodeId: "e5",
      scrollX: 0,
      scrollY: 200,
    });
  });

  test("对话框 / 录制 / 可见性族", async () => {
    expect(await mapOne("dialog", { action: "get" })).toEqual({ method: "getDialog" });
    expect(await mapOne("dialog", { action: "handle", accept: true, promptText: "hi" })).toEqual({
      method: "handleDialog",
      accept: true,
      promptText: "hi",
    });
    expect(await mapOne("recording", { action: "start", options: { maxDurationMs: 5_000 } })).toEqual({
      method: "recordingStart",
      options: { maxDurationMs: 5_000 },
    });
    expect(await mapOne("recording", { action: "status", recordingId: "r1" })).toEqual({
      method: "recordingStatus",
      recordingId: "r1",
    });
    expect(await mapOne("recording", { action: "cancel", recordingId: "r1", tabId: "t1" })).toEqual({
      method: "recordingCancel",
      recordingId: "r1",
      tabId: "t1",
    });
    expect(await mapOne("visibility", {})).toEqual({ method: "browserVisibilityGet" });
    expect(await mapOne("visibility", { visible: true })).toEqual({ method: "browserVisibilitySet", visible: true });
  });
});

describe("zod 协议闸", () => {
  test("越界参数经真实工具调用被 zod 闸拦截", async () => {
    const { tools } = makeTools(() => ({ ok: true }));
    const tool = toolByName(tools, "viewport");
    const result = await tool.call({ action: "set", width: 100, height: 100 }, { toolUseId: "tu-1" } as never);
    expect(result.is_error).toBe(true);
    const text = typeof result.content === "string" ? result.content : "";
    expect(text).toContain("invalid browserViewportSet arguments");
  });
});

describe("结果塑形", () => {
  test("成功结果剥 meta/elapsedMs,错误结果折进 is_error", async () => {
    const { tools: okTools } = makeTools(() => ({
      ok: true,
      elapsedMs: 12,
      meta: {
        browserUse: true,
        backendType: "iab",
        browserId: "iab:test",
        browserGeneration: 1,
        openTabIds: ["t1"],
      },
      tabs: [{ tabId: "t1", url: "https://example.com/", title: "Example", viewport: { width: 800, height: 600 } }],
    }));
    const okTool = toolByName(okTools, "tabs_list");
    const okResult = await okTool.call({}, { toolUseId: "tu-1" } as never);
    expect(okResult.is_error).toBeUndefined();
    const okPayload = JSON.parse(okResult.content as string) as Record<string, unknown>;
    expect(okPayload.ok).toBe(true);
    expect(okPayload.meta).toBeUndefined();
    expect(okPayload.elapsedMs).toBeUndefined();
    expect(Array.isArray(okPayload.tabs)).toBe(true);

    const { tools: errTools } = makeTools(() => ({
      ok: false,
      error: { code: "timeout", message: "browser 命令 navigate 超时(30000ms)", sideEffect: "uncertain" },
    }));
    const errTool = toolByName(errTools, "navigate");
    const errResult = await errTool.call({ url: "https://example.com/" }, { toolUseId: "tu-2" } as never);
    expect(errResult.is_error).toBe(true);
    const errPayload = JSON.parse(errResult.content as string) as Record<string, unknown>;
    expect(errPayload.ok).toBe(false);
    expect((errPayload.error as Record<string, unknown>).code).toBe("timeout");
  });

  test("tabs_new 携带 url:newTab 成功后同调用导航,tabId 回填进结果", async () => {
    const { commands, tools } = makeTools((input) =>
      input.command.method === "newTab"
        ? {
          ok: true,
          meta: {
            browserUse: true,
            backendType: "iab",
            browserId: "iab:test",
            browserGeneration: 1,
            openTabIds: ["tab-1"],
            tabId: "tab-1",
          },
        }
        : { ok: true },
    );
    const tool = toolByName(tools, "tabs_new");
    const result = await tool.call({ url: "https://example.com/" }, { toolUseId: "tu-1" } as never);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual({ method: "newTab" });
    expect(commands[1]).toEqual({ method: "navigate", tabId: "tab-1", url: "https://example.com/" });
    const payload = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(payload.tabId).toBe("tab-1");
    expect(payload.ok).toBe(true);
  });
});
