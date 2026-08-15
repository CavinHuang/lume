import { describe, expect, test } from "bun:test";
import { createNodeReplTools } from "./create-node-repl-tools";
import { createNodeReplRuntimeRegistry } from "./node-repl-runtime-registry";
import { JsonlNodeReplRuntimeClient } from "./node-repl-runtime-manager";
import type {
  JsExecInput,
  NodeReplRuntimeClient,
  NodeReplRuntimeExecOptions,
  NodeReplExecutionResult
} from "./node-repl-types";

interface HostResultWrite {
  method: string;
  params: { id: string; ok: boolean; value?: unknown; error?: string };
}

function createHostCallHarness(options: NodeReplRuntimeExecOptions) {
  const writes: HostResultWrite[] = [];
  const client = new JsonlNodeReplRuntimeClient({
    threadId: "thread-1",
    cwd: "D:/repo",
    hostPath: "host.js",
    kernelPath: "kernel.js",
    nodePath: "node.exe"
  });
  (client as any).child = {
    stdin: {
      writable: true,
      write(line: string, _encoding: string, callback?: (error?: Error | null) => void) {
        writes.push(JSON.parse(line) as HostResultWrite);
        callback?.(null);
        return true;
      }
    },
    kill() {}
  };
  (client as any).activeExecs.set("exec-1", {
    options,
    abortController: new AbortController(),
    computerUseResults: []
  });
  async function emitHostCall(method: string, args?: unknown): Promise<HostResultWrite | undefined> {
    const before = writes.length;
    await (client as any).handleRuntimeHostCall({
      type: "runtime_host_call",
      id: `host-${before + 1}`,
      exec_id: "exec-1",
      method,
      args
    });
    return writes[before];
  }
  return { emitHostCall };
}

function createTestRuntime(): NodeReplRuntimeClient {
  const vars = new Map<string, number>();
  return {
    async exec(input: JsExecInput): Promise<NodeReplExecutionResult> {
      if (input.code.includes("var answer = 40")) {
        vars.set("answer", 40);
        return { content: [{ type: "text", text: "" }] };
      }
      if (input.code.includes("answer += 2")) {
        const next = (vars.get("answer") ?? 0) + 2;
        vars.set("answer", next);
        return { content: [{ type: "text", text: String(next) }] };
      }
      if (input.code.includes("emitImage")) {
        return { content: [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }] };
      }
      if (input.code.includes("setResponseMeta")) {
        return { content: [{ type: "text", text: "" }], _meta: { traceId: "t-1" } };
      }
      return { content: [{ type: "text", text: "" }] };
    },
    async addNodeModuleDirectory() {
      return true;
    },
    async reset() {
      vars.clear();
    },
    async shutdown() {}
  };
}

function createContractTools() {
  return createNodeReplTools({
    sessionId: "thread-1",
    cwd: "D:/repo",
    registry: createNodeReplRuntimeRegistry(() => createTestRuntime())
  });
}

function makeToolContext() {
  return { cwd: "D:/repo", sessionId: "thread-1", toolUseId: "tool-1" } as any;
}

describe("node_repl tool contract", () => {
  test("js instructions require explicit output", () => {
    const js = createContractTools().find((tool) => tool.name === "js")!;

    expect(js.description).toContain("nodeRepl.write");
    expect(js.description).toContain("Bare final expressions are not returned");
    expect(js.description).toContain("JSON.stringify");
  });

  test("persistent bindings survive js calls until reset", async () => {
    const tools = createContractTools();
    const js = tools.find((tool) => tool.name === "js")!;

    await js.call({ code: "var answer = 40" }, makeToolContext());
    const result = await js.call({ code: "answer += 2; nodeRepl.write(String(answer))" }, makeToolContext());

    expect(result.content).toEqual([{ type: "text", text: "42" }]);
  });

  test("emitImage returns an image block", async () => {
    const tools = createContractTools();
    const js = tools.find((tool) => tool.name === "js")!;

    const result = await js.call({ code: "await nodeRepl.emitImage('data:image/png;base64,ZmFrZQ==')" }, makeToolContext());

    expect((result.content as any[])[0]).toMatchObject({ type: "image", data: "ZmFrZQ==", mimeType: "image/png" });
  });

  test("setResponseMeta returns top-level _meta", async () => {
    const tools = createContractTools();
    const js = tools.find((tool) => tool.name === "js")!;

    const result = await js.call({ code: "nodeRepl.setResponseMeta({ traceId: 't-1' })" }, makeToolContext());

    expect((result as any)._meta).toEqual({ traceId: "t-1" });
  });
});

describe("node_repl tool bridge host calls", () => {
  test("tool_call routes to toolRequest and writes the result back", async () => {
    const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
    const { emitHostCall } = createHostCallHarness({
      toolRequest: async (request) => {
        calls.push(request);
        return { content: [{ type: "text", text: "done" }] };
      }
    });

    const write = await emitHostCall("tool_call", { name: "search", params: { query: "lume" } });

    expect(calls).toEqual([{ method: "tool_call", args: { name: "search", params: { query: "lume" } } }]);
    expect(write).toMatchObject({
      method: "host_result",
      params: { ok: true, value: { content: [{ type: "text", text: "done" }] } }
    });
  });

  test("tool_list routes to toolRequest with empty args", async () => {
    const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
    const { emitHostCall } = createHostCallHarness({
      toolRequest: async (request) => {
        calls.push(request);
        return { tools: [], documentation: "docs" };
      }
    });

    const write = await emitHostCall("tool_list", {});

    expect(calls).toEqual([{ method: "tool_list", args: {} }]);
    expect(write).toMatchObject({
      params: { ok: true, value: { tools: [], documentation: "docs" } }
    });
  });

  test("missing toolRequest returns a structured error without crashing", async () => {
    const { emitHostCall } = createHostCallHarness({});

    const write = await emitHostCall("tool_call", { name: "search", params: {} });

    expect(write).toMatchObject({
      params: { ok: false, error: "tools bridge is unavailable" }
    });
  });

  test("toolRequest rejection surfaces the error message", async () => {
    const { emitHostCall } = createHostCallHarness({
      toolRequest: async () => {
        throw new Error("permission denied");
      }
    });

    const write = await emitHostCall("tool_list", {});

    expect(write).toMatchObject({
      params: { ok: false, error: "permission denied" }
    });
  });
});
