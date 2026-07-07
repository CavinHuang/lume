import { describe, expect, test } from "bun:test";
import { createComputerUseMcpTools } from "./create-computer-use-tools";
import { submitDesktopActionDecision } from "../../interruption/desktop-action-session";

describe("createComputerUseMcpTools", () => {
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

  test("returns an explicit unavailable status when the host is not configured", async () => {
    const [tool] = createComputerUseMcpTools();
    const result = await tool!.call({}, { toolUseId: "tool-2" } as never);
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

    expect(calls).toHaveLength(1);
    expect(JSON.parse(result.content as string)).toEqual({ status: "ok" });
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
});
