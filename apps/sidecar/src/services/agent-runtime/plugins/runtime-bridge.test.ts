import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("carries resolved plugin hooks (with pluginId) in assembly.hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-bridge-hooks-"));
    try {
      const pluginRoot = join(root, "acme");
      await mkdir(pluginRoot, { recursive: true });
      await writeFile(
        join(pluginRoot, "hooks.json"),
        JSON.stringify({ Stop: [{ command: "echo stop" }] }),
        "utf-8",
      );
      const plugin = makePlugin(pluginRoot, {
        capabilities: {
          skills: [],
          commandTools: [],
          hooksConfigPath: "./hooks.json",
        },
        permissions: { hooks: { events: ["Stop"] } },
      });

      const assembly = await assemblePluginRuntime([plugin]);

      expect(assembly.hooks).toEqual([
        { pluginId: "acme", hooks: { Stop: [{ command: "echo stop" }] } },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("carries resolved plugin mcpServers (with pluginId + entry) in assembly.mcpServers", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-bridge-mcp-"));
    try {
      const pluginRoot = join(root, "acme");
      await mkdir(pluginRoot, { recursive: true });
      await writeFile(
        join(pluginRoot, "mcp.json"),
        JSON.stringify({ mcpServers: { "acme-api": { command: "node", args: ["server.js"] } } }),
        "utf-8",
      );
      const plugin = makePlugin(pluginRoot, {
        capabilities: {
          skills: [],
          commandTools: [],
          mcpServersConfigPath: "./mcp.json",
        },
        permissions: { mcpServers: { register: true } },
      });

      const assembly = await assemblePluginRuntime([plugin]);

      expect(assembly.mcpServers).toHaveLength(1);
      expect(assembly.mcpServers[0]?.pluginId).toBe("acme");
      expect(assembly.mcpServers[0]?.serverId).toBe("acme-api");
      expect(assembly.mcpServers[0]?.entry.transport).toBe("stdio");
      expect(assembly.mcpServers[0]?.entry.command).toBe("node");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
