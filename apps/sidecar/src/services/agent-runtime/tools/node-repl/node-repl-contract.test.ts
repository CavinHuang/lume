import { describe, expect, test } from "bun:test";
import { createNodeReplTools } from "./create-node-repl-tools";
import { createNodeReplRuntimeRegistry } from "./node-repl-runtime-registry";
import type { JsExecInput, NodeReplRuntimeClient, NodeReplExecutionResult } from "./node-repl-types";

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
