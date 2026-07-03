import { describe, expect, test } from "bun:test";
import { createNodeReplMcpTools, createNodeReplTools } from "./create-node-repl-tools";
import { createNodeReplRuntimeRegistry } from "./node-repl-runtime-registry";
import type { NodeReplRuntimeClient } from "./node-repl-types";
import { submitBrowserAuthResponse } from "../../interruption/browser-auth-session";

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

  test("js resolves browserAuth through pending interactive without returning secrets", async () => {
    const emitted: any[] = [];
    let runtimeAuthResult: unknown;
    const tools = createNodeReplTools({
      sessionId: "thread-1",
      cwd: "D:/repo",
      emitBrowserAuthRequest: (request) => emitted.push(request),
      registry: {
        async exec(_threadId, _input, options) {
          runtimeAuthResult = await options?.emitBrowserAuthRequest?.({
            context: { threadId: "thread-1", browserSessionId: "browser-session", browserTurnId: "turn-1" },
            tabId: "tab-1",
            origin: "https://accounts.example.test",
            reason: "Sign in.",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            fields: [{ id: "password", label: "Password", type: "password", required: true }]
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

    const pending = js!.call({ code: "await nodeRepl.browserAuth.request({})" }, makeToolContext());
    await waitFor(() => emitted.length > 0);
    await submitBrowserAuthResponse({
      threadId: emitted[0].threadId,
      requestId: emitted[0].requestId,
      status: "submitted",
      values: { password: "password-value" }
    });
    const result = await pending;

    expect(runtimeAuthResult).toEqual({ status: "approved", values: { password: "password-value" } });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ status: "approved" }) }]);
    expect(JSON.stringify(result)).not.toContain("password-value");
    expect(JSON.stringify(emitted)).not.toContain("password-value");
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition timed out");
}
