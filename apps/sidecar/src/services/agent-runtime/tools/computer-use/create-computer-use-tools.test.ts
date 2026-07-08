import { describe, expect, test } from "bun:test";
import { createComputerUseMcpTools } from "./create-computer-use-tools";
import { submitDesktopActionDecision } from "../../interruption/desktop-action-session";

describe("createComputerUseMcpTools", () => {
  test("publishes concrete schemas for desktop targeting and safe text entry", () => {
    const tools = createComputerUseMcpTools();
    const schema = (name: string) => tools.find((tool) => tool.name.endsWith(`__${name}`))!
      .inputSchema as Record<string, any>;
    const description = (name: string) => tools.find((tool) => tool.name.endsWith(`__${name}`))!
      .description;

    expect(schema("get_window").required).toEqual(["windowId"]);
    expect(schema("click").required).toContain("windowId");
    expect(schema("click").anyOf).toEqual([
      { required: ["elementId"] },
      { required: ["x", "y"] },
    ]);
    expect(schema("drag").required).toEqual(["windowId", "fromX", "fromY", "toX", "toY"]);
    expect(schema("type_text").required).toEqual(["windowId", "text"]);
    expect(schema("search_context").required).toEqual(["query"]);
    expect(schema("diagnose_permissions").required).toBeUndefined();
    expect(schema("request_permissions").required).toBeUndefined();
    expect(schema("current_context").properties.refresh).toMatchObject({ type: "boolean" });
    expect(description("type_text")).toContain("passwords or OTPs");
    expect(description("click")).toContain("get_window_state");
    expect(description("diagnose_permissions")).toContain("Lume Computer Use.app");
    expect(description("request_permissions")).toContain("Lume Computer Use.app");
    for (const tool of tools) {
      expect((tool.inputSchema as unknown as Record<string, unknown>).additionalProperties).toBe(false);
    }
  });

  test("makes windowId optional for bound desktop conversation tools", () => {
    const tools = createComputerUseMcpTools({ boundDesktopContextSnapshotId: "snap-bound" });
    const required = (name: string) => (
      tools.find((tool) => tool.name === `mcp__computer_use__${name}`)!.inputSchema as Record<string, any>
    ).required;

    expect(required("get_window")).toBeUndefined();
    expect(required("get_window_state")).toBeUndefined();
    expect(required("activate_window")).toBeUndefined();
    expect(required("click")).toBeUndefined();
    expect(required("scroll")).toEqual(["deltaY"]);
    expect(required("drag")).toEqual(["fromX", "fromY", "toX", "toY"]);
    expect(required("press_key")).toBeUndefined();
    expect(required("type_text")).toEqual(["text"]);
    expect(required("set_value")).toEqual(["value"]);
    expect(required("wait_for_state")).toBeUndefined();
  });

  test("explains that bound desktop conversations can omit windowId", () => {
    const tools = createComputerUseMcpTools({ boundDesktopContextSnapshotId: "snap-bound" });
    const click = tools.find((tool) => tool.name === "mcp__computer_use__click")!;
    const getWindowState = tools.find((tool) => tool.name === "mcp__computer_use__get_window_state")!;
    const unboundClick = createComputerUseMcpTools().find((tool) => tool.name === "mcp__computer_use__click")!;

    expect(click.description).toContain("attached desktop app");
    expect(getWindowState.description).toContain("attached desktop app");
    expect(unboundClick.description).not.toContain("attached desktop app");
  });

  test("forwards the original method and structured input", async () => {
    const calls: unknown[] = [];
    const tools = createComputerUseMcpTools({
      invoke: async (method, input) => {
        calls.push({ method, input });
        return { status: "ok", apps: [{ id: "wechat", name: "微信" }] };
      },
    });
    const tool = tools.find((candidate) => candidate.name === "mcp__computer_use__list_apps");

    const result = await tool!.call({ includeBackground: false }, { toolUseId: "tool-1" } as never);

    expect(calls).toEqual([{ method: "list_apps", input: { includeBackground: false } }]);
    expect(JSON.parse(result.content as string)).toEqual({
      status: "ok",
      apps: [{ id: "wechat", name: "微信" }],
    });
  });

  test("publishes a read-only macOS permission diagnostic tool", async () => {
    const calls: unknown[] = [];
    const tools = createComputerUseMcpTools({
      invoke: async (method, input) => {
        calls.push({ method, input });
        return {
          status: "ok",
          permissionTarget: {
            appName: "Lume Computer Use",
            bundleId: "com.lume.computer-use",
          },
          permissions: [
            { id: "accessibility", status: "missing" },
            { id: "screenRecording", status: "granted" },
          ],
        };
      },
    });
    const tool = tools.find((candidate) => candidate.name === "mcp__computer_use__diagnose_permissions")!;

    expect(tool.isReadOnly?.()).toBe(true);
    expect(tool.isConcurrencySafe?.()).toBe(true);
    const result = await tool.call({}, { toolUseId: "tool-permissions" } as never);

    expect(calls).toEqual([{ method: "diagnose_permissions", input: {} }]);
    expect(JSON.parse(result.content as string)).toEqual({
      status: "ok",
      permissionTarget: {
        appName: "Lume Computer Use",
        bundleId: "com.lume.computer-use",
      },
      permissions: [
        { id: "accessibility", status: "missing" },
        { id: "screenRecording", status: "granted" },
      ],
    });
  });

  test("publishes an app-scoped macOS permission request tool", async () => {
    const calls: unknown[] = [];
    const tools = createComputerUseMcpTools({
      invoke: async (method, input) => {
        calls.push({ method, input });
        return {
          status: "permission_denied",
          permissionTarget: {
            appName: "Lume Computer Use",
            appBundleName: "Lume Computer Use.app",
            bundleId: "com.lume.computer-use",
          },
          permissions: [
            { id: "accessibility", status: "missing" },
            { id: "screenRecording", status: "missing" },
          ],
        };
      },
    });
    const tool = tools.find((candidate) => candidate.name === "mcp__computer_use__request_permissions")!;

    expect(tool.isReadOnly?.()).toBe(false);
    expect(tool.runtimeMetadata?.sideEffects).toBe("desktop");
    const result = await tool.call({}, { toolUseId: "tool-request-permissions" } as never);

    expect(calls).toEqual([{ method: "request_permissions", input: {} }]);
    expect(JSON.parse(result.content as string)).toMatchObject({
      status: "permission_denied",
      permissionTarget: {
        appName: "Lume Computer Use",
        appBundleName: "Lume Computer Use.app",
        bundleId: "com.lume.computer-use",
      },
    });
  });

  test("returns desktop screenshots as image blocks instead of base64 JSON text", async () => {
    const tools = createComputerUseMcpTools({
      invoke: async () => ({
        status: "ok",
        screenshots: [{
          id: "screenshot:window-1:rev-1",
          width: 320,
          height: 200,
          origin: { x: 10, y: 20 },
          mimeType: "image/png",
          dataUrl: "data:image/png;base64,iVBORw0KGgo=",
        }],
      }),
    });
    const getWindowState = tools.find((tool) => tool.name === "mcp__computer_use__get_window_state")!;

    const result = await getWindowState.call(
      { windowId: "window-1", includeScreenshot: true },
      { toolUseId: "tool-screenshot" } as never,
    );

    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          status: "ok",
          screenshots: [{
            id: "screenshot:window-1:rev-1",
            width: 320,
            height: 200,
            origin: { x: 10, y: 20 },
            mimeType: "image/png",
          }],
        }),
      },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
        _meta: { screenshotId: "screenshot:window-1:rev-1", persist: false },
      },
    ]);
  });

  test("extracts screenshots nested under retained desktop context snapshots", async () => {
    const tools = createComputerUseMcpTools({
      invoke: async () => ({
        status: "ok",
        snapshot: {
          id: "snap-1",
          screenshots: [{
            id: "shot-1",
            width: 320,
            height: 200,
            origin: { x: 10, y: 20 },
            mimeType: "image/png",
            dataUrl: "data:image/png;base64,iVBORw0KGgo=",
          }],
        },
      }),
    });
    const currentContext = tools.find((tool) => tool.name === "mcp__computer_use__current_context")!;

    const result = await currentContext.call(
      { snapshotId: "snap-1", includeScreenshot: true },
      { toolUseId: "tool-current-image" } as never,
    );

    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          status: "ok",
          snapshot: {
            id: "snap-1",
            screenshots: [{
              id: "shot-1",
              width: 320,
              height: 200,
              origin: { x: 10, y: 20 },
              mimeType: "image/png",
            }],
          },
        }),
      },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
        _meta: { screenshotId: "shot-1", persist: false },
      },
    ]);
  });

  test("keeps current_context pinned to the desktop snapshot bound to the run", async () => {
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const tools = createComputerUseMcpTools({
      boundDesktopContextSnapshotId: "snap-bound",
      invoke: async (method, input) => {
        calls.push({ method, input });
        return { status: "ok" };
      },
    });
    const currentContext = tools.find((candidate) => candidate.name === "mcp__computer_use__current_context")!;

    await currentContext.call({}, { toolUseId: "tool-current-context" } as never);
    await currentContext.call({ snapshotId: "snap-explicit" }, { toolUseId: "tool-current-context-2" } as never);
    await currentContext.call({ snapshotId: "snap-explicit", refresh: true }, { toolUseId: "tool-current-context-3" } as never);

    expect(calls).toEqual([
      { method: "current_context", input: { snapshotId: "snap-bound" } },
      { method: "current_context", input: { snapshotId: "snap-bound" } },
      { method: "current_context", input: { snapshotId: "snap-bound", refresh: true } },
    ]);
  });

  test("anchors get_window_state to the bound conversation window when windowId is omitted", async () => {
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const tools = createComputerUseMcpTools({
      boundDesktopContextSnapshotId: "snap-wechat",
      invoke: async (method, input) => {
        calls.push({ method, input });
        if (method === "current_context") {
          return {
            status: "ok",
            snapshot: {
              id: "snap-wechat",
              app: { id: "wechat.exe", name: "微信" },
              window: { id: "win:wechat", title: "项目群" },
            },
          };
        }
        return { status: "ok", window: { id: "win:wechat" } };
      },
    });
    const getWindowState = tools.find((candidate) => candidate.name === "mcp__computer_use__get_window_state")!;

    await getWindowState.call(
      { includeScreenshot: true },
      { toolUseId: "tool-bound-state" } as never,
    );

    expect(calls).toEqual([
      { method: "current_context", input: { snapshotId: "snap-wechat" } },
      { method: "get_window_state", input: { windowId: "win:wechat", includeScreenshot: true } },
    ]);
  });

  test("anchors bound window read tools when windowId is omitted", async () => {
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const tools = createComputerUseMcpTools({
      boundDesktopContextSnapshotId: "snap-wechat",
      invoke: async (method, input) => {
        calls.push({ method, input });
        if (method === "current_context") {
          return {
            status: "ok",
            snapshot: {
              id: "snap-wechat",
              app: { id: "wechat.exe", name: "微信" },
              window: { id: "win:wechat", title: "项目群" },
            },
          };
        }
        return { status: "ok" };
      },
    });
    const getWindow = tools.find((candidate) => candidate.name === "mcp__computer_use__get_window")!;
    const waitForState = tools.find((candidate) => candidate.name === "mcp__computer_use__wait_for_state")!;

    await getWindow.call({}, { toolUseId: "tool-bound-window" } as never);
    await waitForState.call(
      { titleContains: "项目", timeoutMs: 500 },
      { toolUseId: "tool-bound-wait" } as never,
    );

    expect(calls).toEqual([
      { method: "current_context", input: { snapshotId: "snap-wechat" } },
      { method: "get_window", input: { windowId: "win:wechat" } },
      { method: "current_context", input: { snapshotId: "snap-wechat" } },
      { method: "wait_for_state", input: { windowId: "win:wechat", titleContains: "项目", timeoutMs: 500 } },
    ]);
  });

  test("anchors desktop actions to the bound conversation window when windowId is omitted", async () => {
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const tools = createComputerUseMcpTools({
      boundDesktopContextSnapshotId: "snap-wechat",
      invoke: async (method, input) => {
        calls.push({ method, input });
        if (method === "current_context") {
          return {
            status: "ok",
            snapshot: {
              id: "snap-wechat",
              app: { id: "wechat.exe", name: "微信" },
              window: { id: "win:wechat", title: "项目群" },
            },
          };
        }
        if (method === "get_window_state") {
          return {
            status: "ok",
            revision: "rev-bound",
            window: { id: "win:wechat", appId: "wechat.exe", appName: "微信" },
            accessibility: {
              tree: [{
                id: "root.input",
                role: "edit",
                name: "输入框",
                bounds: { x: 100, y: 200, width: 300, height: 40 },
              }],
            },
          };
        }
        return { status: "ok" };
      },
    });
    const click = tools.find((candidate) => candidate.name === "mcp__computer_use__click")!;

    await click.call(
      { elementId: "root.input" },
      { toolUseId: "tool-bound-action" } as never,
    );

    expect(calls).toEqual([
      { method: "current_context", input: { snapshotId: "snap-wechat" } },
      { method: "get_window_state", input: { windowId: "win:wechat" } },
      {
        method: "click",
        input: {
          elementId: "root.input",
          windowId: "win:wechat",
          appId: "wechat.exe",
          appName: "微信",
          targetLabel: "输入框",
          windowRevision: "rev-bound",
          x: 250,
          y: 220,
        },
      },
      { method: "wait_for_state", input: { windowId: "win:wechat", revisionNot: "rev-bound", timeoutMs: 1_500 } },
    ]);
  });

  test("returns an explicit unavailable status when the host is not configured", async () => {
    const tool = createComputerUseMcpTools()
      .find((candidate) => candidate.name === "mcp__computer_use__list_apps")!;
    const result = await tool.call({}, { toolUseId: "tool-2" } as never);
    expect(JSON.parse(result.content as string)).toEqual({
      status: "unavailable",
      message: "Lume desktop host is not configured",
    });
  });

  test("requires a one-time confirmation for consequential actions", async () => {
    const calls: unknown[] = [];
    const requests: Array<{ threadId: string; requestId: string; targetLabel?: string }> = [];
    const tools = createComputerUseMcpTools({
      threadId: "thread-1",
      emitDesktopActionRequest: (request) => requests.push(request),
      invoke: async (method, input) => {
        calls.push({ method, input });
        return { status: "ok" };
      },
    });
    const click = tools.find((tool) => tool.name === "mcp__computer_use__click")!;
    const resultPromise = click.call(
      { appId: "wechat.exe", appName: "微信", windowId: "window-1", windowRevision: "rev-1", targetLabel: "发送" },
      { toolUseId: "tool-3", abortSignal: new AbortController().signal } as never,
    );

    await Bun.sleep(0);
    expect(calls).toEqual([]);
    expect(requests[0]?.targetLabel).toBe("发送");
    submitDesktopActionDecision({
      threadId: "thread-1",
      requestId: requests[0]!.requestId,
      decision: "allow_once",
    });
    const result = await resultPromise;

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({
      method: "wait_for_state",
      input: { windowId: "window-1", revisionNot: "rev-1", timeoutMs: 1_500 },
    });
    expect(JSON.parse(result.content as string)).toEqual({ status: "ok", verification: { status: "ok" } });
  });

  test("captures a fresh window revision before confirming consequential actions", async () => {
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const requests: Array<{ threadId: string; requestId: string; expectedRevision?: string }> = [];
    const tools = createComputerUseMcpTools({
      threadId: "thread-2",
      emitDesktopActionRequest: (request) => requests.push(request),
      invoke: async (method, input) => {
        calls.push({ method, input });
        if (method === "get_window_state") return { status: "ok", revision: "fresh-rev" };
        return { status: "ok" };
      },
    });
    const click = tools.find((tool) => tool.name === "mcp__computer_use__click")!;
    const resultPromise = click.call(
      { appId: "wechat.exe", appName: "微信", windowId: "window-1", targetLabel: "发送" },
      { toolUseId: "tool-4", abortSignal: new AbortController().signal } as never,
    );

    await Bun.sleep(0);
    expect(calls).toEqual([{ method: "get_window_state", input: { windowId: "window-1" } }]);
    expect(requests[0]?.expectedRevision).toBe("fresh-rev");
    submitDesktopActionDecision({
      threadId: "thread-2",
      requestId: requests[0]!.requestId,
      decision: "allow_once",
    });
    await resultPromise;

    expect(calls[1]).toEqual({
      method: "click",
      input: { appId: "wechat.exe", appName: "微信", windowId: "window-1", targetLabel: "发送", windowRevision: "fresh-rev" },
    });
  });

  test("derives consequential target labels from element ids before action confirmation", async () => {
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const requests: Array<{ threadId: string; requestId: string; targetLabel?: string; expectedRevision?: string; targetPoint?: { x: number; y: number } }> = [];
    const tools = createComputerUseMcpTools({
      threadId: "thread-derived",
      emitDesktopActionRequest: (request) => requests.push(request),
      invoke: async (method, input) => {
        calls.push({ method, input });
        if (method === "get_window_state" || method === "wait_for_state") {
          return {
            status: "ok",
            revision: "derived-rev",
            window: { id: "window-1", appId: "wechat.exe", appName: "微信" },
            accessibility: {
              tree: [
                { id: "root.0", role: "edit", name: "输入框" },
                { id: "root.1", role: "button", name: "发送", bounds: { x: 240, y: 600, width: 80, height: 40 } },
              ],
            },
          };
        }
        return { status: "ok" };
      },
    });
    const click = tools.find((tool) => tool.name === "mcp__computer_use__click")!;
    const resultPromise = click.call(
      { windowId: "window-1", windowRevision: "stale-or-known-rev", elementId: "root.1" },
      { toolUseId: "tool-derived", abortSignal: new AbortController().signal } as never,
    );

    await Bun.sleep(0);
    expect(calls).toEqual([{ method: "get_window_state", input: { windowId: "window-1" } }]);
    expect(requests[0]).toMatchObject({
      targetLabel: "发送",
      expectedRevision: "derived-rev",
      targetPoint: { x: 280, y: 620 },
    });
    submitDesktopActionDecision({
      threadId: "thread-derived",
      requestId: requests[0]!.requestId,
      decision: "allow_once",
    });
    const result = await resultPromise;

    expect(calls[1]).toEqual({
      method: "click",
      input: {
        windowId: "window-1",
        windowRevision: "derived-rev",
        elementId: "root.1",
        targetLabel: "发送",
        appId: "wechat.exe",
        appName: "微信",
        x: 280,
        y: 620,
      },
    });
    expect(calls[2]).toEqual({
      method: "wait_for_state",
      input: { windowId: "window-1", revisionNot: "derived-rev", timeoutMs: 1_500 },
    });
    expect(JSON.parse(result.content as string)).toEqual({
      status: "ok",
      verification: {
        status: "ok",
        revision: "derived-rev",
        window: { id: "window-1" },
      },
    });
  });

  test("derives consequential focused target labels for keyboard actions", async () => {
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const requests: Array<{ threadId: string; requestId: string; targetLabel?: string }> = [];
    const tools = createComputerUseMcpTools({
      threadId: "thread-focused",
      emitDesktopActionRequest: (request) => requests.push(request),
      invoke: async (method, input) => {
        calls.push({ method, input });
        if (method === "get_window_state") {
          return {
            status: "ok",
            revision: "focused-rev",
            window: { id: "window-2", appId: "pay.exe", appName: "支付应用" },
            accessibility: {
              focusedElement: { id: "root.4", role: "button", name: "付款" },
            },
          };
        }
        return { status: "ok" };
      },
    });
    const pressKey = tools.find((tool) => tool.name === "mcp__computer_use__press_key")!;
    const resultPromise = pressKey.call(
      { windowId: "window-2", key: "ENTER" },
      { toolUseId: "tool-focused", abortSignal: new AbortController().signal } as never,
    );

    await Bun.sleep(0);
    expect(requests[0]?.targetLabel).toBe("付款");
    submitDesktopActionDecision({
      threadId: "thread-focused",
      requestId: requests[0]!.requestId,
      decision: "allow_once",
    });
    await resultPromise;

    expect(calls).toEqual([
      { method: "get_window_state", input: { windowId: "window-2" } },
      {
        method: "press_key",
        input: {
          windowId: "window-2",
          key: "ENTER",
          windowRevision: "focused-rev",
          targetLabel: "付款",
          appId: "pay.exe",
          appName: "支付应用",
        },
      },
      {
        method: "wait_for_state",
        input: { windowId: "window-2", revisionNot: "focused-rev", timeoutMs: 1_500 },
      },
    ]);
  });

  test("emits desktop action visual lifecycle without leaking typed text", async () => {
    const visualEvents: unknown[] = [];
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const tools = createComputerUseMcpTools({
      threadId: "thread-visual",
      runId: "run-visual",
      emitDesktopActionVisualEvent: (event) => visualEvents.push(event),
      invoke: async (method, input) => {
        calls.push({ method, input });
        return { status: "ok" };
      },
    });
    const typeText = tools.find((tool) => tool.name === "mcp__computer_use__type_text")!;

    const result = await typeText.call(
      { appId: "wechat.exe", appName: "微信", windowId: "win-1", targetLabel: "输入框", text: "password=secret" },
      { toolUseId: "tool-visual", abortSignal: new AbortController().signal } as never,
    );

    expect(calls).toEqual([
      {
        method: "type_text",
        input: { appId: "wechat.exe", appName: "微信", windowId: "win-1", targetLabel: "输入框", text: "password=secret" },
      },
      { method: "get_window_state", input: { windowId: "win-1" } },
    ]);
    expect(JSON.parse(result.content as string)).toEqual({ status: "ok", verification: { status: "ok" } });
    expect(visualEvents).toHaveLength(2);
    expect(visualEvents[0]).toMatchObject({
      type: "desktop.action_visual",
      phase: "started",
      threadId: "thread-visual",
      runId: "run-visual",
      toolCallId: "tool-visual",
      action: "type_text",
      app: { id: "wechat.exe", name: "微信" },
      targetLabel: "输入框",
    });
    expect(visualEvents[1]).toMatchObject({
      type: "desktop.action_visual",
      phase: "completed",
      status: "ok",
    });
    expect(JSON.stringify(visualEvents)).not.toContain("password=secret");
  });

  test("derives visual cursor points and paths from element bounds before element actions", async () => {
    const visualEvents: Array<{ phase: string; point?: { x: number; y: number }; path?: Array<{ x: number; y: number }> }> = [];
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const tools = createComputerUseMcpTools({
      threadId: "thread-element-visual",
      runId: "run-element-visual",
      emitDesktopActionVisualEvent: (event) => visualEvents.push(event),
      invoke: async (method, input) => {
        calls.push({ method, input });
        if (method === "get_window_state") {
          return {
            status: "ok",
            revision: "bounds-rev",
            window: { id: "win-1", appId: "wechat.exe", appName: "微信" },
            accessibility: {
              tree: [
                {
                  id: "root.1",
                  role: "button",
                  name: "打开",
                  bounds: { x: 100, y: 200, width: 60, height: 40 },
                },
              ],
            },
          };
        }
        return { status: "ok" };
      },
    });
    const click = tools.find((tool) => tool.name === "mcp__computer_use__click")!;

    await click.call(
      { appId: "wechat.exe", appName: "微信", windowId: "win-1", elementId: "root.1" },
      { toolUseId: "tool-element-visual" } as never,
    );

    expect(calls[0]).toEqual({ method: "get_window_state", input: { windowId: "win-1" } });
    expect(calls[1]).toEqual({
      method: "click",
      input: {
        appId: "wechat.exe",
        appName: "微信",
        windowId: "win-1",
        elementId: "root.1",
        targetLabel: "打开",
        windowRevision: "bounds-rev",
        x: 130,
        y: 220,
      },
    });
    expect(visualEvents[0]).toMatchObject({
      phase: "started",
      point: { x: 130, y: 220 },
      path: [
        { x: 58, y: 172 },
        { x: 130, y: 220 },
      ],
    });
    expect(visualEvents[1]).toMatchObject({
      phase: "completed",
      point: { x: 130, y: 220 },
      path: [
        { x: 58, y: 172 },
        { x: 130, y: 220 },
      ],
    });
  });

  test("emits visual cursor paths for pointer movement actions", async () => {
    const visualEvents: Array<{ phase: string; point?: { x: number; y: number }; path?: Array<{ x: number; y: number }> }> = [];
    const tools = createComputerUseMcpTools({
      threadId: "thread-path-visual",
      runId: "run-path-visual",
      emitDesktopActionVisualEvent: (event) => visualEvents.push(event),
      invoke: async () => ({ status: "ok" }),
    });
    const drag = tools.find((tool) => tool.name === "mcp__computer_use__drag")!;

    await drag.call(
      { appId: "wechat.exe", appName: "微信", windowId: "win-1", fromX: 100, fromY: 120, toX: 420, toY: 360 },
      { toolUseId: "tool-path-visual" } as never,
    );

    expect(visualEvents[0]).toMatchObject({
      phase: "started",
      point: { x: 420, y: 360 },
      path: [
        { x: 100, y: 120 },
        { x: 420, y: 360 },
      ],
    });
    expect(visualEvents[1]).toMatchObject({
      phase: "completed",
      path: [
        { x: 100, y: 120 },
        { x: 420, y: 360 },
      ],
    });
  });

  test("adds a lightweight post-action verification for successful window-scoped actions", async () => {
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const tools = createComputerUseMcpTools({
      invoke: async (method, input) => {
        calls.push({ method, input });
        if (method === "get_window_state") {
          return {
            status: "ok",
            revision: "rev-after",
            window: { id: "win-1", title: "项目群", focused: true },
            accessibility: {
              focusedElement: { id: "root.1", role: "edit", name: "输入框", value: "typed text", settable: true },
            },
          };
        }
        return { status: "ok", inputMode: "uia_value" };
      },
    });
    const setValue = tools.find((tool) => tool.name === "mcp__computer_use__set_value")!;

    const result = await setValue.call(
      { appId: "wechat.exe", appName: "微信", windowId: "win-1", targetLabel: "输入框", value: "typed text" },
      { toolUseId: "tool-verify" } as never,
    );

    expect(calls).toEqual([
      {
        method: "set_value",
        input: { appId: "wechat.exe", appName: "微信", windowId: "win-1", targetLabel: "输入框", value: "typed text" },
      },
      { method: "get_window_state", input: { windowId: "win-1" } },
    ]);
    expect(JSON.parse(result.content as string)).toEqual({
      status: "ok",
      inputMode: "uia_value",
      verification: {
        status: "ok",
        revision: "rev-after",
        window: { id: "win-1", title: "项目群", focused: true },
        focusedElement: { id: "root.1", role: "edit", name: "输入框", settable: true },
      },
    });
    expect(result.content as string).not.toContain("typed text");
  });

  test("waits for a revision change before verifying actions with a known window revision", async () => {
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const tools = createComputerUseMcpTools({
      invoke: async (method, input) => {
        calls.push({ method, input });
        if (method === "wait_for_state") {
          return {
            status: "ok",
            revision: "rev-after",
            window: { id: "win-1", title: "项目群", focused: true },
          };
        }
        return { status: "ok" };
      },
    });
    const click = tools.find((tool) => tool.name === "mcp__computer_use__click")!;

    const result = await click.call(
      {
        appId: "wechat.exe",
        appName: "微信",
        windowId: "win-1",
        windowRevision: "rev-before",
        targetLabel: "展开详情",
        x: 130,
        y: 220,
      },
      { toolUseId: "tool-wait-verify" } as never,
    );

    expect(calls).toEqual([
      {
        method: "click",
        input: {
          appId: "wechat.exe",
          appName: "微信",
          windowId: "win-1",
          windowRevision: "rev-before",
          targetLabel: "展开详情",
          x: 130,
          y: 220,
        },
      },
      {
        method: "wait_for_state",
        input: { windowId: "win-1", revisionNot: "rev-before", timeoutMs: 1_500 },
      },
    ]);
    expect(JSON.parse(result.content as string)).toEqual({
      status: "ok",
      verification: {
        status: "ok",
        revision: "rev-after",
        window: { id: "win-1", title: "项目群", focused: true },
      },
    });
  });

  test("falls back to the current window state when post-action revision waiting times out", async () => {
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const tools = createComputerUseMcpTools({
      invoke: async (method, input) => {
        calls.push({ method, input });
        if (method === "wait_for_state") return { status: "timeout", message: "revision unchanged" };
        if (method === "get_window_state") {
          return {
            status: "ok",
            revision: "rev-before",
            window: { id: "win-1", title: "项目群", focused: true },
          };
        }
        return { status: "ok" };
      },
    });
    const click = tools.find((tool) => tool.name === "mcp__computer_use__click")!;

    const result = await click.call(
      {
        appId: "wechat.exe",
        appName: "微信",
        windowId: "win-1",
        windowRevision: "rev-before",
        targetLabel: "展开详情",
        x: 130,
        y: 220,
      },
      { toolUseId: "tool-wait-timeout" } as never,
    );

    expect(calls).toEqual([
      {
        method: "click",
        input: {
          appId: "wechat.exe",
          appName: "微信",
          windowId: "win-1",
          windowRevision: "rev-before",
          targetLabel: "展开详情",
          x: 130,
          y: 220,
        },
      },
      {
        method: "wait_for_state",
        input: { windowId: "win-1", revisionNot: "rev-before", timeoutMs: 1_500 },
      },
      { method: "get_window_state", input: { windowId: "win-1" } },
    ]);
    expect(JSON.parse(result.content as string)).toEqual({
      status: "ok",
      verification: {
        status: "ok",
        revision: "rev-before",
        window: { id: "win-1", title: "项目群", focused: true },
      },
    });
  });

  test("marks non-ok desktop action results as a failed visual phase", async () => {
    const visualEvents: Array<{ phase: string; status?: string }> = [];
    const tools = createComputerUseMcpTools({
      threadId: "thread-unavailable",
      emitDesktopActionVisualEvent: (event) => visualEvents.push(event),
      invoke: async () => ({ status: "unavailable", message: "desktop host is offline" }),
    });
    const click = tools.find((tool) => tool.name === "mcp__computer_use__click")!;

    await click.call(
      { appId: "wechat.exe", appName: "微信", targetLabel: "输入框" },
      { toolUseId: "tool-unavailable" } as never,
    );

    expect(visualEvents).toEqual([
      expect.objectContaining({ phase: "started" }),
      expect.objectContaining({ phase: "failed", status: "unavailable" }),
    ]);
  });

  test("does not let visual event listener failures block desktop actions", async () => {
    let invoked = false;
    const tools = createComputerUseMcpTools({
      emitDesktopActionVisualEvent: () => {
        throw new Error("renderer disconnected");
      },
      invoke: async () => {
        invoked = true;
        return { status: "ok" };
      },
    });
    const click = tools.find((tool) => tool.name === "mcp__computer_use__click")!;

    const result = await click.call({}, { toolUseId: "tool-observer-failure" } as never);

    expect(invoked).toBe(true);
    expect(JSON.parse(result.content as string)).toEqual({ status: "ok" });
  });
});
