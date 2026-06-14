import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SidecarPluginManager } from "./plugin-manager.js";

describe("SidecarPluginManager compatibility wrapper", () => {
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
});
