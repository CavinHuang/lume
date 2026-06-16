import { describe, expect, test } from "bun:test";
import { buildPluginMcpManager, PLUGIN_MCP_WORKSPACE_SLUG } from "./plugin-mcp-bridge.js";
import type { ResolvedMcpServer } from "./capability-resolver.js";
import type { PluginPermissionRuntime } from "./permission-runtime.js";
import type { WorkspaceSdkMcpManager } from "../../mcp/workspace-mcp-manager.js";

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

const fakeServers: ResolvedMcpServer[] = [
  { pluginId: "acme", serverId: "api", entry: { enabled: true, transport: "stdio", command: "node", args: ["s.js"] } },
];

function makeRuntime(decision: "allow" | "deny" | "ask"): PluginPermissionRuntime {
  return {
    async checkSensitiveCapability() {
      return { decision, reason: `fake ${decision}` };
    },
  } as unknown as PluginPermissionRuntime;
}

describe("buildPluginMcpManager §8.1 start gate", () => {
  test("allow decision connects the server", async () => {
    const runtime = makeRuntime("allow");
    let connected = false;
    const manager = buildPluginMcpManager(fakeServers, {
      permissionRuntime: runtime,
      workspaceSlug: "ws",
      sdkManagerFactory: (): WorkspaceSdkMcpManager => ({
        sync: () => {},
        ensureConnected: async () => { connected = true; },
        disconnect: async () => {},
        dispose: async () => {},
        getStatus: () => ({
          "acme:api": {
            serverId: "acme:api",
            name: "acme:api",
            transport: "stdio",
            enabled: true,
            status: "connected",
            tools: [],
            toolDetails: [],
          },
        }),
        getTools: () => [],
        callTool: async () => ({ text: "", isError: false }),
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
      }),
    });
    await manager.createRuntimeTools(PLUGIN_MCP_WORKSPACE_SLUG);
    expect(connected).toBe(true);
  });

  test("deny/ask decision blocks connect (server never connects)", async () => {
    const runtime = makeRuntime("ask");
    let connected = false;
    const manager = buildPluginMcpManager(fakeServers, {
      permissionRuntime: runtime,
      workspaceSlug: "ws",
      sdkManagerFactory: (): WorkspaceSdkMcpManager => ({
        sync: () => {},
        ensureConnected: async () => { connected = true; },
        disconnect: async () => {},
        dispose: async () => {},
        getStatus: () => ({
          "acme:api": {
            serverId: "acme:api",
            name: "acme:api",
            transport: "stdio",
            enabled: true,
            status: "connected",
            tools: [],
            toolDetails: [],
          },
        }),
        getTools: () => [],
        callTool: async () => ({ text: "", isError: false }),
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
      }),
    });
    await manager.createRuntimeTools(PLUGIN_MCP_WORKSPACE_SLUG);
    expect(connected).toBe(false);
  });
});
