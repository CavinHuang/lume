import { describe, expect, test } from "bun:test";
import { createNodeReplRuntimeRegistry } from "./node-repl-runtime-registry";
import type { JsExecInput, NodeReplRuntimeClient } from "./node-repl-types";

function createFakeNodeReplClient(options: { failWithTimeout?: boolean } = {}): NodeReplRuntimeClient & {
  resetCalls: number;
  shutdownCalls: number;
} {
  return {
    resetCalls: 0,
    shutdownCalls: 0,
    async exec(_input: JsExecInput) {
      if (options.failWithTimeout) {
        throw new Error("timeout");
      }
      return { content: [{ type: "text", text: "ok" }] };
    },
    async addNodeModuleDirectory(_dir: string) {
      return true;
    },
    async reset() {
      this.resetCalls += 1;
    },
    async shutdown() {
      this.shutdownCalls += 1;
    }
  };
}

describe("node-repl runtime registry", () => {
  test("reset clears bindings but preserves module dirs", async () => {
    const client = createFakeNodeReplClient();
    const registry = createNodeReplRuntimeRegistry(() => client);

    await registry.addModuleDir("thread-1", "D:/repo/node_modules");
    await registry.exec("thread-1", { code: "var answer = 1", timeout_ms: 1000 });
    await registry.reset("thread-1");

    expect(client.resetCalls).toBe(1);
    expect(registry.debugSnapshot("thread-1")?.moduleDirs).toEqual(["D:/repo/node_modules"]);
  });

  test("duplicate module dirs return false", async () => {
    const registry = createNodeReplRuntimeRegistry(() => createFakeNodeReplClient());

    expect(await registry.addModuleDir("thread-1", "D:/repo/node_modules")).toBe(true);
    expect(await registry.addModuleDir("thread-1", "D:/repo/node_modules")).toBe(false);
  });

  test("timeout drops the current runtime instance", async () => {
    const client = createFakeNodeReplClient({ failWithTimeout: true });
    const registry = createNodeReplRuntimeRegistry(() => client);

    await expect(registry.exec("thread-1", { code: "while(true){}", timeout_ms: 1 })).rejects.toThrow(/timeout/i);

    expect(client.shutdownCalls).toBe(1);
    expect(registry.debugSnapshot("thread-1")).toBeNull();
  });
});
