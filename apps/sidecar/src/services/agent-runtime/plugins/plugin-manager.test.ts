import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isBundledBrowserPluginAvailable, SidecarPluginManager } from "./plugin-manager.js";

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf-8");
}

describe("SidecarPluginManager compatibility wrapper", () => {
  test("detects the bundled browser manifest without user plugin state", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-bundled-browser-"));
    try {
      await writeJson(join(root, "browser", ".lume-plugin", "plugin.json"), {
        schema: "lume-plugin/v1",
        name: "browser",
        version: "1.0.0",
      });

      expect(isBundledBrowserPluginAvailable(root)).toBe(true);
      expect(isBundledBrowserPluginAvailable(join(root, "missing"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("discovers trusted bundled plugins independently from the install store", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-plugin-manager-"));
    try {
      await writeJson(join(root, "bundled", "computer-use", ".lume-plugin", "plugin.json"), {
        schema: "lume-plugin/v1",
        name: "computer-use",
        version: "1.0.0",
      });
      const manager = new SidecarPluginManager(
        join(root, "installed"),
        join(root, "state.json"),
        [join(root, "bundled")],
      );

      const plugins = await manager.listRegistered({ enabled: [], directories: [] });

      expect(plugins).toHaveLength(1);
      expect(plugins[0]).toMatchObject({
        pluginId: "computer-use",
        builtin: true,
        permissionState: { state: "loaded", reason: "bundled-plugin" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resolveEnabled delegates to PluginRegistry and preserves legacy shape", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-plugin-manager-"));
    try {
      await mkdir(join(root, "alpha"), { recursive: true });
      await writeFile(
        join(root, "alpha", "lume-plugin.json"),
        JSON.stringify({
          schema: "lume-plugin/v1",
          name: "alpha",
          version: "1.0.0",
          permissions: { tools: { deny: ["Bash"] } },
        }),
      );

      const manager = new SidecarPluginManager(root, join(root, "state.json"));
      const plugins = await manager.resolveEnabled({ enabled: ["alpha"], directories: [] });

      expect(plugins[0]?.name).toBe("alpha");
      expect(plugins[0]?.manifest.permissions?.tools?.deny).toContain("Bash");

      const contexts = await manager.buildInterceptorContexts({ enabled: ["alpha"], directories: [] });
      expect(contexts[0]?.pluginName).toBe("alpha");
      const contextPermissions = contexts[0]?.permissions as { tools?: { deny?: string[] } } | undefined;
      expect(contextPermissions?.tools?.deny).toContain("Bash");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("listRegistered returns RegisteredPlugin[] with permissionState and capabilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-plugins-"));
    try {
      await writeJson(join(root, "acme", "lume-plugin.json"), {
        schema: "lume-plugin/v1",
        name: "acme",
        version: "1.0.0",
        commandTools: [{ name: "echo", command: "node" }],
      });
      const manager = new SidecarPluginManager(root, join(root, "state.json"));
      const plugins = await manager.listRegistered({ enabled: [], directories: [] });

      expect(plugins).toHaveLength(1);
      const plugin = plugins[0];
      expect(plugin?.pluginId).toBe("acme");
      expect(plugin?.root).toBe(join(root, "acme"));
      expect(plugin?.capabilities.commandTools.map((t) => t.name)).toEqual(["echo"]);
      expect(plugin?.permissionState).toBeDefined();
      const state = plugin?.permissionState?.state;
      expect(state).toBeDefined();
      if (state) {
        expect(["loaded", "needs-review", "not-loaded"]).toContain(state);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
