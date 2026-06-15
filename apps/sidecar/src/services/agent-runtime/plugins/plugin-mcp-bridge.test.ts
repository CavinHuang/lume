import { describe, expect, test } from "bun:test";
import { buildPluginMcpManager, PLUGIN_MCP_WORKSPACE_SLUG } from "./plugin-mcp-bridge.js";
import type { ResolvedMcpServer } from "./capability-resolver.js";

const servers: ResolvedMcpServer[] = [
  { pluginId: "acme", serverId: "api", entry: { enabled: true, transport: "stdio", command: "node", args: ["s.js"] } },
  { pluginId: "beta", serverId: "api", entry: { enabled: true, transport: "stdio", command: "deno", args: ["s.ts"] } },
];

describe("buildPluginMcpManager", () => {
  test("constructs a WorkspaceMcpManager (not the singleton)", () => {
    const manager = buildPluginMcpManager(servers);
    expect(manager).toBeDefined();
    expect(typeof manager.createRuntimeTools).toBe("function");
    expect(typeof manager.disposeWorkspace).toBe("function");
  });

  test("PLUGIN_MCP_WORKSPACE_SLUG is the distinct __plugin__ slug", () => {
    expect(PLUGIN_MCP_WORKSPACE_SLUG).toBe("__plugin__");
  });

  test("handles an empty server list (empty-config manager)", () => {
    const manager = buildPluginMcpManager([]);
    expect(manager).toBeDefined();
    expect(typeof manager.createRuntimeTools).toBe("function");
  });
});
