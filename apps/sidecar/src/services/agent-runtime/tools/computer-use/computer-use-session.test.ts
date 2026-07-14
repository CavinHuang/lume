import { describe, expect, test } from "bun:test";
import {
  ComputerUseSessionRegistry,
  getComputerUseSessionRegistry,
  type ComputerUseSessionRequest,
} from "./computer-use-session";
import { createComputerUseMcpTools } from "./create-computer-use-tools";

describe("ComputerUseSessionRegistry", () => {
  test("provides one process registry for production tool adapters", () => {
    expect(getComputerUseSessionRegistry()).toBe(getComputerUseSessionRegistry());
  });

  test("reuses one serialized session per thread until it is cleared", async () => {
    const registry = new ComputerUseSessionRegistry();
    const releaseFirst = Promise.withResolvers<void>();
    const calls: string[] = [];
    const execute = async (request: ComputerUseSessionRequest) => {
      calls.push(`start:${request.method}`);
      if (request.method === "list_apps") await releaseFirst.promise;
      calls.push(`end:${request.method}`);
      return { value: request.method };
    };

    const first = registry.getOrCreate({ threadId: "thread-1", execute });
    const reused = registry.getOrCreate({ threadId: "thread-1", execute });
    expect(reused).toBe(first);
    expect(registry.isActive("thread-1")).toBeFalse();

    const firstRequest = first.request({ method: "list_apps", params: {}, context: {} });
    expect(registry.isActive("thread-1")).toBeTrue();
    const secondRequest = reused.request({ method: "list_windows", params: {}, context: {} });
    await Bun.sleep(0);
    expect(calls).toEqual(["start:list_apps"]);

    releaseFirst.resolve();
    await Promise.all([firstRequest, secondRequest]);
    expect(calls).toEqual([
      "start:list_apps",
      "end:list_apps",
      "start:list_windows",
      "end:list_windows",
    ]);

    registry.clear("thread-1");
    expect(registry.isActive("thread-1")).toBeFalse();
    expect(registry.getOrCreate({ threadId: "thread-1", execute })).not.toBe(first);
  });

  test("keeps canonical windows when MCP tool adapters are recreated", async () => {
    const registry = new ComputerUseSessionRegistry();
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const canonicalWindow = {
      id: 42,
      app: "D:\\software\\Tencent\\Weixin\\Weixin.exe",
      title: "小树懒",
    };
    const invoke = async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "list_apps") {
        return [{ id: canonicalWindow.app, windows: [canonicalWindow] }];
      }
      if (method === "get_window") return canonicalWindow;
      return null;
    };

    const firstTools = createComputerUseMcpTools({
      threadId: "thread-canonical",
      invoke,
      sessionRegistry: registry,
    });
    await tool(firstTools, "list_apps").call({}, { toolUseId: "list" } as never);

    const secondTools = createComputerUseMcpTools({
      threadId: "thread-canonical",
      invoke,
      sessionRegistry: registry,
    });
    await tool(secondTools, "get_window").call({ id: 42 }, { toolUseId: "get" } as never);

    expect(calls.at(-1)).toEqual({
      method: "get_window",
      params: { id: 42, app: canonicalWindow.app },
    });
  });
});

function tool(tools: ReturnType<typeof createComputerUseMcpTools>, name: string) {
  return tools.find((candidate) => candidate.name === `mcp__computer_use__${name}`)!;
}
