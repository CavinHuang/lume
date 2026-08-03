import { describe, expect, test } from "bun:test";
import { mkdir, writeFile, rm } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { PluginManager } from "./manager.js";

describe("PluginManager", () => {
  const testRoot = join(homedir(), ".lume", "plugins", "cache");
  const dataRoot = join(homedir(), ".lume", "plugins", "data");

  test("installs a plugin from a source directory", async () => {
    const manager = new PluginManager(testRoot, dataRoot);
    const src = join(testRoot, "_src", "demo");
    await mkdir(src, { recursive: true });
    await writeFile(
      join(src, "lume-plugin.json"),
      JSON.stringify({
        schema: "lume-plugin/v1",
        name: "demo",
        version: "1.0.0",
        skills: ["./skills/"],
      }),
    );
    await mkdir(join(src, "skills"), { recursive: true });

    const result = await manager.install({ source: src, pluginName: "demo" });

    expect(result.installedPath).toBeDefined();
    expect(result.installedPath?.replace(/\\/g, "/")).toContain("cache/demo/local");
    expect(result.version).toBe("local");
  });

  test("lists installed plugins", async () => {
    const manager = new PluginManager(testRoot, dataRoot);
    // Install two plugins
    for (const [name, ver] of [
      ["alpha", "1.0.0"],
      ["beta", "2.0.0"],
    ]) {
      const src = join(testRoot, "_src", name);
      await mkdir(src, { recursive: true });
      await writeFile(
        join(src, "lume-plugin.json"),
        JSON.stringify({ schema: "lume-plugin/v1", name, version: ver }),
      );
      await manager.install({ source: src, pluginName: name });
    }

    const listed = await manager.list();
    const names = listed.map((p) => p.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
  });

  test("uninstalls a plugin", async () => {
    const manager = new PluginManager(testRoot, dataRoot);
    const src = join(testRoot, "_src", "temp");
    await mkdir(src, { recursive: true });
    await writeFile(
      join(src, "lume-plugin.json"),
      JSON.stringify({ schema: "lume-plugin/v1", name: "temp", version: "1.0.0" }),
    );
    await manager.install({ source: src, pluginName: "temp" });
    expect(await manager.list()).toContainEqual(
      expect.objectContaining({ name: "temp" }),
    );

    await manager.uninstall("temp");
    expect(await manager.list()).not.toContainEqual(
      expect.objectContaining({ name: "temp" }),
    );
  });

  test("resolves the active version (highest semver)", async () => {
    const manager = new PluginManager(testRoot, dataRoot);
    const pluginDir = join(testRoot, "semver-test");
    for (const ver of ["1.0.0", "1.2.0", "2.0.0"]) {
      const verDir = join(pluginDir, ver);
      await mkdir(verDir, { recursive: true });
      await writeFile(
        join(verDir, "lume-plugin.json"),
        JSON.stringify({
          schema: "lume-plugin/v1",
          name: "semver-test",
          version: ver,
        }),
      );
    }

    const active = manager.resolveActiveVersion("semver-test");
    expect(active).toBe("2.0.0");
  });

  test("loads manifest from installed path", async () => {
    const manager = new PluginManager(testRoot, dataRoot);
    const src = join(testRoot, "_src", "load-test");
    await mkdir(src, { recursive: true });
    await writeFile(
      join(src, "lume-plugin.json"),
      JSON.stringify({
        schema: "lume-plugin/v1",
        name: "load-test",
        version: "1.0.0",
        skills: ["./skills/"],
        hooks: "./hooks/hooks.json",
      }),
    );
    await manager.install({ source: src, pluginName: "load-test" });

    const loaded = await manager.load("load-test");
    expect(loaded.name).toBe("load-test");
    expect(loaded.skills).toEqual(["./skills/"]);
    expect(loaded.hooks).toBe("./hooks/hooks.json");
  });
});
