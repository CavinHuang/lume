import { describe, expect, test } from "bun:test";
import { McpClientManager, setDefaultMcpSdkClientConstructor } from "./manager.js";

// Injected through the module seam instead of mock.module: replacing the
// whole SDK client module would leak into every other suite sharing bun's
// single test process.
class FakeMcpClient {
  static instances: FakeMcpClient[] = [];
  tools: Array<{ name: string; inputSchema?: unknown }> = [];
  closed = 0;

  constructor(_info: unknown, options: any) {
    this.options = options;
    FakeMcpClient.instances.push(this);
  }

  options: any;

  async connect() {}

  async listTools() {
    return { tools: this.tools };
  }

  async close() {
    this.closed += 1;
  }

  emitToolsChanged() {
    const handler = this.options?.listChanged?.tools?.onChanged;
    if (!handler) throw new Error("default client factory did not subscribe to tools/list_changed");
    void handler(undefined, undefined);
  }
}

setDefaultMcpSdkClientConstructor(FakeMcpClient as any);

const config = { enabled: true, transport: "streamable_http", url: "http://127.0.0.1:8787/mcp" } as const;

describe("default client factory (#384)", () => {
  test("subscribes to tools/list_changed and refreshes the tool list in place", async () => {
    FakeMcpClient.instances = [];
    const manager = new McpClientManager({ transportFactory: () => ({}) });
    manager.sync({ dynamic: config });
    await manager.ensureConnected("dynamic");

    expect(FakeMcpClient.instances).toHaveLength(1);
    expect(manager.getTools("dynamic")).toEqual([]);

    const client = FakeMcpClient.instances[0]!;
    client.tools = [{ name: "fresh_tool", inputSchema: { type: "object" } }];
    client.emitToolsChanged();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(manager.getTools("dynamic").map((tool) => tool.originalName)).toEqual(["fresh_tool"]);
    expect(manager.getTools("dynamic")[0]?.wrapperName).toBe("mcp__dynamic__fresh_tool");
  });

  test("ignores stale notifications after disconnect instead of resurrecting tools", async () => {
    FakeMcpClient.instances = [];
    const manager = new McpClientManager({ transportFactory: () => ({}) });
    manager.sync({ dynamic: config });
    await manager.ensureConnected("dynamic");

    const client = FakeMcpClient.instances[0]!;
    client.tools = [{ name: "late_tool" }];
    await manager.disconnect("dynamic");
    client.emitToolsChanged();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(manager.getTools("dynamic")).toEqual([]);
    // The refresh failure path must not leave an unhandled rejection either.
    client.options.listChanged.tools.onChanged(new Error("boom"));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  test("keeps the last good tool list when the refresh request fails", async () => {
    FakeMcpClient.instances = [];
    const manager = new McpClientManager({ transportFactory: () => ({}) });
    manager.sync({ dynamic: config });
    await manager.ensureConnected("dynamic");

    const client = FakeMcpClient.instances[0]!;
    client.tools = [{ name: "stable" }];
    client.emitToolsChanged();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(manager.getTools("dynamic").map((tool) => tool.originalName)).toEqual(["stable"]);

    client.listTools = async () => {
      throw new Error("connection reset");
    };
    client.emitToolsChanged();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(manager.getTools("dynamic").map((tool) => tool.originalName)).toEqual(["stable"]);
  });
});
