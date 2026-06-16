import { describe, expect, test } from "bun:test";
import { evaluatePluginSensitiveGate } from "./sensitive-gate.js";
import type { LumeToolDescriptor } from "../tools/tool-types.js";
import type { PluginPermissionRuntime, SensitiveCheckResult } from "./permission-runtime.js";

/** Build a fake runtime returning a fixed decision for any key. */
function fakeRuntime(decision: SensitiveCheckResult["decision"]): PluginPermissionRuntime {
  return {
    async checkSensitiveCapability(): Promise<SensitiveCheckResult> {
      return { decision, reason: decision === "allow" ? "prior allow" : "no prior approval" };
    },
  } as unknown as PluginPermissionRuntime;
}

function descriptor(name: string, pluginId?: string): LumeToolDescriptor {
  return {
    name,
    canonicalName: name,
    source: "plugin",
    definition: {
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
      async call() { return { type: "tool_result", tool_use_id: "", content: "" }; },
      ...(pluginId ? { runtimeMetadata: { source: "plugin", pluginId } } : {}),
    },
  } as unknown as LumeToolDescriptor;
}

/**
 * Plugin-MCP tool descriptor. Stamping (Task 1/5, run.ts + create-mcp-tools.ts) injects
 * `{ source:"plugin", pluginId, capability:"mcp" }` then `create-mcp-tools.ts` appends
 * `mcpServerId: tool.serverId` (the namespaced `${pluginId}:${serverId}` id). mcpServerId
 * must match the start gate's serverId (plugin-mcp-bridge.ts) for approval reuse.
 */
function mcpDescriptor(
  name: string,
  pluginId: string,
  mcpServerId: string,
): LumeToolDescriptor {
  return {
    name,
    canonicalName: name,
    source: "plugin",
    definition: {
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
      async call() { return { type: "tool_result", tool_use_id: "", content: "" }; },
      runtimeMetadata: { source: "plugin", pluginId, capability: "mcp", mcpServerId },
    },
  } as unknown as LumeToolDescriptor;
}

/** A fake runtime that captures the {pluginId, key} of each check call. */
function capturingRuntime(
  decision: SensitiveCheckResult["decision"],
  calls: Array<{ pluginId: string; key: string }>,
): PluginPermissionRuntime {
  return {
    async checkSensitiveCapability(params: { pluginId: string; key: string }): Promise<SensitiveCheckResult> {
      calls.push({ pluginId: params.pluginId, key: params.key });
      return { decision, reason: decision === "allow" ? "approved" : "denied" };
    },
  } as unknown as PluginPermissionRuntime;
}

describe("evaluatePluginSensitiveGate", () => {
  test("allows a non-plugin tool (no runtimeMetadata.pluginId)", async () => {
    const result = await evaluatePluginSensitiveGate({
      descriptor: descriptor("Bash"),
      runtime: fakeRuntime("deny"),
      workspaceSlug: "ws",
    });
    expect(result.decision).toBe("allow");
  });

  test("allows a plugin tool when checkSensitiveCapability returns allow", async () => {
    const result = await evaluatePluginSensitiveGate({
      descriptor: descriptor("echo", "acme"),
      runtime: fakeRuntime("allow"),
      workspaceSlug: "ws",
    });
    expect(result.decision).toBe("allow");
  });

  test("blocks a plugin tool when checkSensitiveCapability returns deny", async () => {
    const result = await evaluatePluginSensitiveGate({
      descriptor: descriptor("echo", "acme"),
      runtime: fakeRuntime("deny"),
      workspaceSlug: "ws",
    });
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("acme");
    expect(result.reason).toContain("commandTool:echo");
  });

  test("blocks a plugin tool when checkSensitiveCapability returns ask (Phase 2 ask→block)", async () => {
    const result = await evaluatePluginSensitiveGate({
      descriptor: descriptor("echo", "acme"),
      runtime: fakeRuntime("ask"),
      workspaceSlug: "ws",
    });
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("acme");
  });

  test("plugin MCP tool uses mcpServer:${mcpServerId} key (§8.1 call gate)", async () => {
    const calls: Array<{ pluginId: string; key: string }> = [];
    const result = await evaluatePluginSensitiveGate({
      // mcpServerId is the namespaced "acme:api" — matches start gate serverId.
      descriptor: mcpDescriptor("mcp__acme:api__search", "acme", "acme:api"),
      runtime: capturingRuntime("allow", calls),
      workspaceSlug: "ws",
    });
    expect(result.decision).toBe("allow");
    expect(calls).toEqual([{ pluginId: "acme", key: "mcpServer:acme:api" }]);
  });

  test("plugin MCP tool with deny decision is blocked with mcpServer key in reason", async () => {
    const calls: Array<{ pluginId: string; key: string }> = [];
    const result = await evaluatePluginSensitiveGate({
      descriptor: mcpDescriptor("mcp__acme:api__search", "acme", "acme:api"),
      runtime: capturingRuntime("deny", calls),
      workspaceSlug: "ws",
    });
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("mcpServer:acme:api");
    expect(calls).toEqual([{ pluginId: "acme", key: "mcpServer:acme:api" }]);
  });

  test("plugin command tool still uses commandTool:${name} key (Phase 3c unchanged)", async () => {
    const calls: Array<{ pluginId: string; key: string }> = [];
    const result = await evaluatePluginSensitiveGate({
      descriptor: descriptor("demo_echo", "demo"),
      runtime: capturingRuntime("deny", calls),
      workspaceSlug: "ws",
    });
    expect(result.decision).toBe("block");
    expect(calls).toEqual([{ pluginId: "demo", key: "commandTool:demo_echo" }]);
  });
});
