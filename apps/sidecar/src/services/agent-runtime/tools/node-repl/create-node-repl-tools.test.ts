import { describe, expect, test } from "bun:test";
import { createNodeReplTools } from "./create-node-repl-tools";
import { createNodeReplRuntimeRegistry } from "./node-repl-runtime-registry";
import type { NodeReplRuntimeClient } from "./node-repl-types";

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
});
