import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PluginRegistry } from "./plugin-registry.js";
import { FilePluginStateStore } from "./plugin-state-store.js";

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf-8");
}

describe("PluginRegistry", () => {
  test("discovers Lume, Codex, and legacy plugin manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-plugin-registry-"));
    try {
      await writeJson(join(root, "plugins", "lume-one", "lume-plugin.json"), {
        schema: "lume-plugin/v1",
        name: "lume-one",
        version: "1.0.0",
      });
      await writeJson(join(root, "plugins", "codex-one", ".codex-plugin", "plugin.json"), {
        name: "codex-one",
        version: "1.0.0",
        interface: {},
      });
      await writeJson(join(root, "plugins", "legacy-one", "plugin.json"), {
        name: "legacy-one",
        tools: [{ name: "echo", command: "echo" }],
      });

      const registry = new PluginRegistry({
        installedRoot: join(root, "plugins"),
        legacyGlobalRoot: join(root, "plugins"),
        stateStore: new FilePluginStateStore(join(root, "state.json")),
      });
      const result = await registry.list({ enabled: [], disabled: [], directories: [] });

      expect(result.plugins.map((plugin) => plugin.pluginId).sort()).toEqual([
        "codex-one",
        "legacy-one",
        "lume-one",
      ]);
      expect(result.plugins.find((plugin) => plugin.pluginId === "codex-one")?.manifestFormat).toBe("codex");
      expect(result.plugins.find((plugin) => plugin.pluginId === "legacy-one")?.manifestFormat).toBe("legacy");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses workspace-local candidate before configured directories, installed store, and legacy global root", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-plugin-registry-"));
    try {
      await writeJson(join(root, "legacy-global", "same", "lume-plugin.json"), {
        schema: "lume-plugin/v1",
        name: "same",
        version: "1.0.0",
      });
      await writeJson(join(root, "installed", "same", "3.0.0", "lume-plugin.json"), {
        schema: "lume-plugin/v1",
        name: "same",
        version: "3.0.0",
      });
      await writeJson(join(root, "extra", "same", "lume-plugin.json"), {
        schema: "lume-plugin/v1",
        name: "same",
        version: "2.0.0",
      });
      await writeJson(join(root, "workspace", ".lume", "plugins", "same", "lume-plugin.json"), {
        schema: "lume-plugin/v1",
        name: "same",
        version: "1.5.0",
      });

      const stateStore = new FilePluginStateStore(join(root, "state.json"));
      await stateStore.write({
        plugins: {
          same: {
            pluginId: "same",
            activeVersion: "3.0.0",
            versions: {
              "3.0.0": {
                pluginId: "same",
                version: "3.0.0",
                source: { type: "local" },
                installedRoot: join(root, "installed", "same", "3.0.0"),
                installedAt: "2026-06-13T00:00:00.000Z",
                sensitiveApprovals: {},
              },
            },
            approvalsByHash: {},
          },
        },
      });

      const registry = new PluginRegistry({
        installedRoot: join(root, "installed"),
        legacyGlobalRoot: join(root, "legacy-global"),
        workspaceRoot: join(root, "workspace", ".lume", "plugins"),
        stateStore,
      });
      const result = await registry.list({ enabled: [], disabled: [], directories: [join(root, "extra")] });

      expect(result.plugins).toHaveLength(1);
      expect(result.plugins[0]?.root).toContain("workspace");
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("duplicate_plugin_ignored");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses activeVersion from installed plugin state", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-plugin-registry-"));
    try {
      const stateStore = new FilePluginStateStore(join(root, "state.json"));
      await writeJson(join(root, "installed", "alpha", "1.0.0", "lume-plugin.json"), {
        schema: "lume-plugin/v1",
        name: "alpha",
        version: "1.0.0",
      });
      await writeJson(join(root, "installed", "alpha", "2.0.0", "lume-plugin.json"), {
        schema: "lume-plugin/v1",
        name: "alpha",
        version: "2.0.0",
      });
      await stateStore.write({
        plugins: {
          alpha: {
            pluginId: "alpha",
            activeVersion: "1.0.0",
            versions: {
              "1.0.0": {
                pluginId: "alpha",
                version: "1.0.0",
                source: { type: "market" },
                installedRoot: join(root, "installed", "alpha", "1.0.0"),
                installedAt: "2026-06-13T00:00:00.000Z",
                permissionsHash: "hash-1",
                permissionsAcceptedAt: "2026-06-13T00:00:00.000Z",
                sensitiveApprovals: {},
              },
              "2.0.0": {
                pluginId: "alpha",
                version: "2.0.0",
                source: { type: "market" },
                installedRoot: join(root, "installed", "alpha", "2.0.0"),
                installedAt: "2026-06-13T00:00:00.000Z",
                sensitiveApprovals: {},
              },
            },
            approvalsByHash: {},
          },
        },
      });

      const registry = new PluginRegistry({
        installedRoot: join(root, "installed"),
        legacyGlobalRoot: join(root, "legacy-global"),
        stateStore,
      });
      const result = await registry.list({ enabled: [], disabled: [], directories: [] });

      expect(result.plugins.find((plugin) => plugin.pluginId === "alpha")?.version).toBe("1.0.0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("carries external review state and keeps scanning after invalid manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-plugin-registry-"));
    try {
      const stateStore = new FilePluginStateStore(join(root, "state.json"));
      await writeJson(join(root, "extra", "external", "lume-plugin.json"), {
        schema: "lume-plugin/v1",
        name: "external",
        version: "1.0.0",
      });
      await writeJson(join(root, "extra", "broken", "lume-plugin.json"), {
        schema: "lume-plugin/v1",
        version: "missing-name",
      });
      const externalPluginRoot = join(root, "extra", "external");
      const externalSourceKey = `directory:${await realpath(externalPluginRoot)}`;
      await stateStore.write({
        plugins: {
          external: {
            pluginId: "external",
            versions: {},
            external: {
              [externalSourceKey]: {
                sourceKey: externalSourceKey,
                permissionsHash: "hash-1",
                sensitiveApprovals: {},
              },
            },
            approvalsByHash: {},
          },
        },
      });

      const registry = new PluginRegistry({
        installedRoot: join(root, "installed"),
        legacyGlobalRoot: join(root, "legacy-global"),
        stateStore,
      });
      const result = await registry.list({ enabled: [], disabled: [], directories: [join(root, "extra")] });

      expect(result.plugins.map((plugin) => plugin.pluginId)).toContain("external");
      expect(result.plugins.find((plugin) => plugin.pluginId === "external")?.state?.permissionsHash).toBe("hash-1");
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("invalid_manifest");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("selects highest semver from versioned directory candidates without install state", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-plugin-registry-"));
    try {
      await writeJson(join(root, "extra", "versioned", "1.0.0", "lume-plugin.json"), {
        schema: "lume-plugin/v1",
        name: "versioned",
        version: "1.0.0",
      });
      await writeJson(join(root, "extra", "versioned", "2.0.0", "lume-plugin.json"), {
        schema: "lume-plugin/v1",
        name: "versioned",
        version: "2.0.0",
      });

      const registry = new PluginRegistry({
        installedRoot: join(root, "installed"),
        legacyGlobalRoot: join(root, "legacy-global"),
        stateStore: new FilePluginStateStore(join(root, "state.json")),
      });
      const result = await registry.list({ enabled: [], disabled: [], directories: [join(root, "extra")] });

      expect(result.plugins.find((plugin) => plugin.pluginId === "versioned")?.version).toBe("2.0.0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
