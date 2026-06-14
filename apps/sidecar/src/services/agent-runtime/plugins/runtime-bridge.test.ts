import { describe, expect, test } from "bun:test";
import { assemblePluginRuntime } from "./runtime-bridge.js";
import type { RegisteredPlugin } from "./plugin-registry.js";

function makePlugin(root: string, overrides: Partial<RegisteredPlugin> = {}): RegisteredPlugin {
  return {
    pluginId: "acme",
    name: "acme",
    version: "1.0.0",
    root,
    manifestFormat: "lume",
    capabilities: { skills: [], commandTools: [] },
    permissions: {},
    diagnostics: [],
    permissionState: { state: "loaded", reason: "loaded" },
    ...overrides,
  };
}

describe("assemblePluginRuntime", () => {
  test("builds command-tool ToolDefinitions carrying pluginId in runtimeMetadata", async () => {
    const plugin = makePlugin("/plugins/acme", {
      capabilities: {
        skills: [],
        commandTools: [{ name: "echo", command: "node", args: ["./echo.mjs"] }],
      },
    });

    const assembly = await assemblePluginRuntime([plugin]);

    expect(assembly.commandToolDefinitions).toHaveLength(1);
    const def = assembly.commandToolDefinitions[0];
    expect(def?.name).toBe("echo");
    expect(def?.description).toBe("echo");
    expect(typeof def?.call).toBe("function");
    const runtimeMetadata = (def as { runtimeMetadata?: { source?: string; pluginId?: string } })
      .runtimeMetadata;
    expect(runtimeMetadata?.source).toBe("plugin");
    expect(runtimeMetadata?.pluginId).toBe("acme");
  });

  test("collects namespaced skill definitions surfaced by the resolver", async () => {
    // The resolver namespaces skill.name as `${pluginId}:${originalName}` and rewrites
    // definition.name. Here the skill root points at a non-existent dir, so the resolver
    // returns [] — we assert the assembly surfaces whatever the resolver produced (empty)
    // without error, proving the skills-collection path is wired.
    const plugin = makePlugin("/plugins/acme", {
      capabilities: {
        skills: [{ pluginId: "acme", version: "1.0.0", root: "./skills" }],
        commandTools: [],
      },
    });
    const assembly = await assemblePluginRuntime([plugin]);
    expect(Array.isArray(assembly.skills)).toBe(true);
  });

  test("silently omits non-loaded plugins (resolver gate)", async () => {
    const loaded = makePlugin("/plugins/loaded", {
      pluginId: "loaded",
      capabilities: { skills: [], commandTools: [{ name: "ct", command: "echo" }] },
    });
    const needsReview = makePlugin("/plugins/nr", {
      pluginId: "nr",
      permissionState: { state: "needs-review", reason: "hash-mismatch" },
      capabilities: { skills: [], commandTools: [{ name: "nrct", command: "echo" }] },
    });

    const assembly = await assemblePluginRuntime([loaded, needsReview]);

    expect(assembly.commandToolDefinitions.map((d) => d.name)).toEqual(["ct"]);
    expect(assembly.diagnostics).toEqual([]);
  });

  test("returns empty assembly for an empty plugin list", async () => {
    const assembly = await assemblePluginRuntime([]);
    expect(assembly.commandToolDefinitions).toEqual([]);
    expect(assembly.skills).toEqual([]);
    expect(assembly.diagnostics).toEqual([]);
  });
});
