import { describe, expect, test } from "bun:test";
import { createNodeReplMcpTools, createNodeReplTools } from "./create-node-repl-tools";
import { createNodeReplRuntimeRegistry } from "./node-repl-runtime-registry";
import type { NodeReplRuntimeClient } from "./node-repl-types";
import { setActiveBrowserBroker } from "../../../browser/browser-broker-holder";

function createFakeClient(): NodeReplRuntimeClient {
  return {
    async exec() {
      return {
        content: [{ type: "text", text: "ready" }],
        _meta: { traceId: "t-1" }
      };
    },
    async addNodeModuleDirectory() {
      return true;
    },
    async reset() {},
    async shutdown() {}
  };
}

function makeToolContext() {
  return { cwd: "D:/repo", sessionId: "thread-1", toolUseId: "tool-1" } as any;
}

describe("createNodeReplTools", () => {
  test("js injects stable request metadata for node_repl consumers", async () => {
    let capturedInput: unknown;
    const tools = createNodeReplTools({
      sessionId: "thread-1",
      cwd: "D:/repo",
      registry: {
        async exec(_threadId, input) {
          capturedInput = input;
          return { content: [{ type: "text", text: "ready" }] };
        },
        async addModuleDir() {
          return true;
        },
        async reset() {},
        async shutdown() {},
        debugSnapshot() {
          return null;
        }
      }
    });
    const js = tools.find((tool) => tool.name === "js");

    await js!.call({ code: "nodeRepl.write('ready')" }, makeToolContext());

    expect(capturedInput).toMatchObject({
      _meta: {
        sessionId: "thread-1",
        threadId: "thread-1",
        toolUseId: "tool-1"
      }
    });
  });

  test("js_add_node_module_dir validates absolute node_modules paths", async () => {
    const tools = createNodeReplTools({
      sessionId: "thread-1",
      cwd: "D:/repo",
      registry: createNodeReplRuntimeRegistry(() => createFakeClient())
    });
    const addDir = tools.find((tool) => tool.name === "js_add_node_module_dir");

    const result = await addDir!.call({ path: "./node_modules" }, makeToolContext());

    expect(result.is_error).toBe(true);
  });

  test("js returns structured content and top-level metadata from runtime", async () => {
    const tools = createNodeReplTools({
      sessionId: "thread-1",
      cwd: "D:/repo",
      registry: createNodeReplRuntimeRegistry(() => createFakeClient())
    });
    const js = tools.find((tool) => tool.name === "js");

    const result = await js!.call({ code: "nodeRepl.write('ready')" }, makeToolContext());

    expect(result.content).toEqual([{ type: "text", text: "ready" }]);
    expect((result as any)._meta).toEqual({ traceId: "t-1" });
  });

  test("js forwards the trusted Computer Use bridge for the active execution", async () => {
    let bridged: unknown;
    const tools = createNodeReplTools({
      sessionId: "thread-1",
      cwd: "D:/repo",
      emitComputerUseRequest: async (request) => ({
        value: { echoed: request.method },
        content: [{ type: "text", text: "visual observation" }],
        meta: { computerUseSurface: "sky" },
      }),
      registry: {
        async exec(_threadId, _input, options) {
          bridged = await options?.emitComputerUseRequest?.(
            { method: "list_windows", params: {} },
            new AbortController().signal,
          );
          return { content: [{ type: "text", text: "ready" }] };
        },
        async addModuleDir() { return true; },
        async reset() {},
        async shutdown() {},
        debugSnapshot() { return null; },
      },
    });

    await tools.find((tool) => tool.name === "js")!.call({ code: "await sky.list_windows()" }, makeToolContext());

    expect(bridged).toEqual({
      value: { echoed: "list_windows" },
      content: [{ type: "text", text: "visual observation" }],
      meta: { computerUseSurface: "sky" },
    });
  });

  test("browser calls keep one lease across node_repl tool calls in the same run", async () => {
    const dispatched: any[] = [];
    setActiveBrowserBroker({
      async dispatch(request: unknown) {
        dispatched.push(request);
        return {};
      }
    } as any);
    const tools = createNodeReplTools({
      sessionId: "thread-1",
      cwd: "D:/repo",
      registry: {
        async exec(_threadId, _input, options) {
          await options?.browserRequest?.(
            { method: "runtime_ping", params: {} },
            new AbortController().signal,
          );
          return { content: [{ type: "text", text: "ready" }] };
        },
        async addModuleDir() { return true; },
        async reset() {},
        async shutdown() {},
        debugSnapshot() { return null; },
      },
    });
    const js = tools.find((tool) => tool.name === "js")!;

    try {
      await js.call({ code: "first" }, { ...makeToolContext(), runId: "run-1", toolUseId: "tool-1" });
      await js.call({ code: "second" }, { ...makeToolContext(), runId: "run-1", toolUseId: "tool-2" });

      expect(dispatched.map((request) => request.browserTurnId)).toEqual(["run-1", "run-1"]);
    } finally {
      setActiveBrowserBroker(null);
    }
  });

  test("stale task-owned browser bindings resume once before retrying the action", async () => {
    const dispatched: any[] = [];
    let actionAttempts = 0;
    setActiveBrowserBroker({
      async dispatch(request: any) {
        dispatched.push(request);
        if (request.method === "resume_handoff_tabs") return [{ tabId: "tab-1" }];
        actionAttempts += 1;
        if (actionAttempts === 1) throw new Error("action_denied");
        return { title: "Recovered" };
      }
    } as any);
    const tools = createNodeReplTools({
      sessionId: "thread-1",
      cwd: "D:/repo",
      registry: {
        async exec(_threadId, _input, options) {
          const result = await options?.browserRequest?.(
            { method: "tab_title", params: { tabId: "tab-1" } },
            new AbortController().signal,
          );
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        },
        async addModuleDir() { return true; },
        async reset() {},
        async shutdown() {},
        debugSnapshot() { return null; },
      },
    });

    try {
      const result = await tools.find((tool) => tool.name === "js")!.call(
        { code: "await tab.title()" },
        { ...makeToolContext(), runId: "run-2" },
      );
      expect(dispatched.map((request) => request.method)).toEqual(["tab_title", "resume_handoff_tabs", "tab_title"]);
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ title: "Recovered" }) }]);
    } finally {
      setActiveBrowserBroker(null);
    }
  });

  test("MCP wrapper exposes node_repl tools with MCP names and metadata", async () => {
    const tools = createNodeReplMcpTools({
      sessionId: "thread-1",
      cwd: "D:/repo",
      registry: createNodeReplRuntimeRegistry(() => createFakeClient())
    });
    const js = tools.find((tool) => tool.name === "mcp__node_repl__js");

    expect(tools.map((tool) => tool.name)).toEqual([
      "mcp__node_repl__js",
      "mcp__node_repl__js_reset",
      "mcp__node_repl__js_add_node_module_dir"
    ]);
    expect(js?.runtimeMetadata).toMatchObject({
      source: "mcp",
      capability: "mcp",
      mcpServerId: "node_repl"
    });

    const result = await js!.call({ code: "nodeRepl.write('ready')" }, makeToolContext());

    expect(result.content).toEqual([{ type: "text", text: "ready" }]);
    expect((result as any)._meta).toEqual({ traceId: "t-1" });
  });

  test("js bridges tool_list and tool_call through the engine context", async () => {
    let catalogResult: unknown;
    let toolCallResult: unknown;
    const nestedCalls: Array<{ toolName: string; params: unknown }> = [];
    const nestedResult = { type: "tool_result", tool_use_id: "nested-1", content: "read ok" };
    const tools = createNodeReplTools({
      sessionId: "thread-1",
      cwd: "D:/repo",
      registry: {
        async exec(_threadId, _input, options) {
          const signal = new AbortController().signal;
          catalogResult = await options?.toolRequest?.({ method: "tool_list", args: {} }, signal);
          toolCallResult = await options?.toolRequest?.(
            { method: "tool_call", args: { name: "Read", params: { path: "x" } } },
            signal,
          );
          return { content: [{ type: "text", text: "ready" }] };
        },
        async addModuleDir() { return true; },
        async reset() {},
        async shutdown() {},
        debugSnapshot() { return null; },
      },
    });
    const context = {
      ...makeToolContext(),
      listAvailableTools: () => [
        { name: "js", description: "Run JavaScript", inputSchema: { type: "object" } },
        { name: "Read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
      ],
      executeNestedTool: async (input: { toolName: string; params: unknown }) => {
        nestedCalls.push(input);
        return nestedResult;
      },
    } as any;

    await tools.find((tool) => tool.name === "js")!.call({ code: "await tools.documentation()" }, context);

    const catalog = catalogResult as { tools: Array<{ name: string }>; documentation: string };
    expect(catalog.tools.map((tool) => tool.name)).toEqual(["Read"]);
    expect(catalog.documentation).toContain("Read");
    expect(catalog.documentation).not.toContain("js");
    expect(nestedCalls).toEqual([{ toolName: "Read", params: { path: "x" } }]);
    expect(toolCallResult).toBe(nestedResult);
  });

  test("js resolves browserAuth through the broker without returning secrets", async () => {
    const dispatched: any[] = [];
    let runtimeAuthResult: unknown;
    setActiveBrowserBroker({
      async dispatch(request: unknown) {
        dispatched.push(request);
        return { status: "submitted", selected_option: "password" };
      }
    } as any);
    const tools = createNodeReplTools({
      sessionId: "thread-1",
      cwd: "D:/repo",
      registry: {
        async exec(_threadId, _input, options) {
          runtimeAuthResult = await options?.emitBrowserAuthRequest?.({
            context: { threadId: "thread-1", browserSessionId: "browser-session", browserTurnId: "turn-1" },
            tabId: "tab-1",
            generation: 4,
            origin: "https://accounts.example.test",
            reason: "Sign in.",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            fields: [{ id: "password", label: "Password", type: "password", required: true, locator: { version: 1, steps: [{ kind: "label", text: "Password" }] } }]
          }, new AbortController().signal);
          return { content: [{ type: "text", text: JSON.stringify({ status: (runtimeAuthResult as any)?.status }) }] };
        },
        async addModuleDir() {
          return true;
        },
        async reset() {},
        async shutdown() {},
        debugSnapshot() {
          return null;
        }
      }
    });
    const js = tools.find((tool) => tool.name === "js");

    const result = await js!.call({ code: "await nodeRepl.browserAuth.request({})" }, makeToolContext());

    expect(runtimeAuthResult).toEqual({ status: "submitted", selected_option: "password" });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ status: "submitted" }) }]);
    expect(dispatched[0]).toMatchObject({ method: "tab_browser_auth_request", tabId: "tab-1" });
    expect(JSON.stringify(result)).not.toContain("password-value");
    expect(JSON.stringify(dispatched)).not.toContain("password-value");
    setActiveBrowserBroker(null);
  });
});
