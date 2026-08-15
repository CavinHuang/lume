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

function createFakeChildClient(hostCallLeaseMs?: number) {
  const writes: HostResultWrite[] = [];
  const client = new JsonlNodeReplRuntimeClient({
    threadId: "thread-1",
    cwd: "D:/repo",
    hostPath: "host.js",
    kernelPath: "kernel.js",
    nodePath: "node.exe",
    ...(hostCallLeaseMs === undefined ? {} : { hostCallLeaseMs })
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
  return { client, writes };
}

function createHostCallHarness(options: NodeReplRuntimeExecOptions) {
  const { client, writes } = createFakeChildClient();
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Scales only the long default exec deadline (>= 30s) down so lease behavior
// is observable with real timers while lease values keep their real duration.
async function scaleLongTimeouts(scale: (ms: number) => number, run: () => Promise<void>): Promise<void> {
  const original = globalThis.setTimeout;
  (globalThis as any).setTimeout = ((handler: TimerHandler, timeout = 0, ...args: unknown[]) =>
    original(handler, scale(timeout), ...(args as []))) as typeof setTimeout;
  try {
    await run();
  } finally {
    (globalThis as any).setTimeout = original;
  }
}

function soleActiveExec(client: JsonlNodeReplRuntimeClient): [string, any] {
  return [...(client as any).activeExecs.entries()][0];
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("expected rejection");
    },
    (error: Error) => error
  );
}

describe("node_repl exec deadline lease", () => {
  test("host call in flight keeps a pending exec alive past the original deadline", async () => {
    await scaleLongTimeouts((ms) => (ms >= 30_000 ? 400 : ms), async () => {
      const { client } = createFakeChildClient(2_000);
      let releaseToolRequest!: (value: unknown) => void;
      const toolRequest = new Promise<unknown>((resolve) => {
        releaseToolRequest = resolve;
      });
      let state = "pending";
      const execPromise = client.exec({ code: "await tools.search('lume')" }, { toolRequest: () => toolRequest });
      void execPromise.then(() => {
        state = "fulfilled";
      }, () => {
        state = "rejected";
      });

      await sleep(100);
      const [execId, active] = soleActiveExec(client);
      void (client as any).handleRuntimeHostCall({
        type: "runtime_host_call",
        id: "host-1",
        exec_id: execId,
        method: "tool_call",
        args: { name: "search", params: {} }
      });

      await sleep(800);
      expect(state).toBe("pending");

      releaseToolRequest({ content: [] });
      (client as any).handleLine(JSON.stringify({
        type: "runtime_response",
        request_id: active.execRequestId,
        ok: true,
        value: { ok: true, output: "done" }
      }));
      const result = await execPromise;
      expect(result.content).toEqual([{ type: "text", text: "done" }]);
    });
  });

  test("exec still times out after the lease when the host call never resolves", async () => {
    await scaleLongTimeouts((ms) => (ms >= 30_000 ? 400 : ms), async () => {
      const { client } = createFakeChildClient(300);
      const execPromise = client.exec({ code: "await tools.search('lume')" }, {
        toolRequest: () => new Promise<unknown>(() => {})
      });

      await sleep(100);
      const [execId] = soleActiveExec(client);
      void (client as any).handleRuntimeHostCall({
        type: "runtime_host_call",
        id: "host-1",
        exec_id: execId,
        method: "tool_call",
        args: { name: "search", params: {} }
      });

      const error = await rejectionOf(execPromise);
      expect(error.message).toContain("timed out after 300ms");
    });
  });

  test("exec without host calls still rejects on the original deadline", async () => {
    await scaleLongTimeouts((ms) => (ms >= 30_000 ? 400 : ms), async () => {
      const { client } = createFakeChildClient();
      const execPromise = client.exec({ code: "while (true) {}" }, {});

      const error = await rejectionOf(execPromise);
      expect(error.message).toContain("timed out after 35000ms");
    });
  });
});
