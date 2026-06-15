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
});
