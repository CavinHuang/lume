import { describe, expect, test } from "bun:test";
import { mkdir, writeFile, rm } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { SidecarPluginManager } from "./plugin-manager.js";

describe("SidecarPluginManager", () => {
  const root = join(homedir(), ".lume", "plugins");

  test("resolves enabled plugins from config", async () => {
    await mkdir(join(root, "alpha"), { recursive: true });
    await writeFile(
      join(root, "alpha", "lume-plugin.json"),
      JSON.stringify({
        schema: "lume-plugin/v1",
        name: "alpha",
        version: "1.0.0",
      }),
    );

    const manager = new SidecarPluginManager(root);
    const config = { enabled: ["alpha"], directories: [] };
    const plugins = manager.resolveEnabled(config);
    expect(plugins.map((p) => p.name)).toContain("alpha");
  });

  test("skips plugins not in enabled list", async () => {
    await mkdir(join(root, "beta"), { recursive: true });
    await writeFile(
      join(root, "beta", "lume-plugin.json"),
      JSON.stringify({
        schema: "lume-plugin/v1",
        name: "beta",
        version: "1.0.0",
      }),
    );

    const manager = new SidecarPluginManager(root);
    // alpha was installed in the first test, beta is new
    // enabled list only includes "alpha", so beta should be skipped
    const config = { enabled: ["alpha"], directories: [] };
    const plugins = manager.resolveEnabled(config);
    expect(plugins.map((p) => p.name)).not.toContain("beta");
  });

  test("scans additional configured directories", async () => {
    const extra = join(root, "_extra");
    await mkdir(join(extra, "gamma"), { recursive: true });
    await writeFile(
      join(extra, "gamma", "lume-plugin.json"),
      JSON.stringify({
        schema: "lume-plugin/v1",
        name: "gamma",
        version: "1.0.0",
      }),
    );

    const manager = new SidecarPluginManager(root);
    const config = { enabled: [], directories: [extra] };
    const plugins = manager.resolveEnabled(config);
    expect(plugins.map((p) => p.name)).toContain("gamma");
  });

  test("builds interceptor contexts for all enabled plugins", async () => {
    await mkdir(join(root, "delta"), { recursive: true });
    await writeFile(
      join(root, "delta", "lume-plugin.json"),
      JSON.stringify({
        schema: "lume-plugin/v1",
        name: "delta",
        version: "1.0.0",
        permissions: {
          tools: { deny: ["Bash"] },
          filesystem: { read: ["./data/**"] },
        },
      }),
    );

    const manager = new SidecarPluginManager(root);
    const config = { enabled: ["delta"], directories: [] };
    const contexts = manager.buildInterceptorContexts(config);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.pluginName).toBe("delta");
    expect((contexts[0]!.permissions as { tools?: { deny?: string[] } }).tools?.deny).toContain("Bash");
  });

  test("returns empty contexts when no plugins match enabled list", async () => {
    // Create a plugin that won't match the enabled list
    await mkdir(join(root, "epsilon"), { recursive: true });
    await writeFile(
      join(root, "epsilon", "lume-plugin.json"),
      JSON.stringify({
        schema: "lume-plugin/v1",
        name: "epsilon",
        version: "1.0.0",
      }),
    );

    const manager = new SidecarPluginManager(root);
    // Request a plugin that doesn't exist
    const contexts = manager.buildInterceptorContexts({
      enabled: ["nonexistent"],
      directories: [],
    });
    expect(contexts).toEqual([]);
  });
});
