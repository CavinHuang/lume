import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computePermissionsHash, normalizePluginManifests } from "@lume/agent-sdk";
import { FilePluginStateStore, type PluginStateFile } from "./plugin-state-store.js";
import { PluginRegistry } from "./plugin-registry.js";

async function writePlugin(root: string, name: string): Promise<string> {
  const pluginRoot = join(root, name);
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, "lume-plugin.json"),
    JSON.stringify({ schema: "lume-plugin/v1", name, version: "1.0.0" }),
  );
  return pluginRoot;
}

function currentHashFor(pluginRoot: string, name: string): string {
  const normalized = normalizePluginManifests({
    pluginRoot,
    lumeManifest: { schema: "lume-plugin/v1", name, version: "1.0.0" },
  });
  return computePermissionsHash(normalized);
}

describe("PluginRegistry permission state", () => {
  test("a discovered plugin with no review state is not-loaded with a capability_filtered diagnostic", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-reg-perm-"));
    try {
      await writePlugin(root, "fresh");

      const registry = new PluginRegistry({
        installedRoot: root,
        legacyGlobalRoot: root,
        stateStore: new FilePluginStateStore(join(root, "state.json")),
      });
      const result = await registry.list({ enabled: [], disabled: [], directories: [] });

      const fresh = result.plugins.find((p) => p.pluginId === "fresh");
      expect(fresh?.permissionState?.state).toBe("not-loaded");
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ pluginId: "fresh", code: "capability_filtered" }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a reviewed plugin whose accepted hash matches current is loaded with no permission diagnostic", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-reg-perm-"));
    try {
      const pluginRoot = await writePlugin(root, "reviewed");
      const acceptedHash = currentHashFor(pluginRoot, "reviewed");

      const stateStore = new FilePluginStateStore(join(root, "state.json"));
      const state: PluginStateFile = {
        plugins: {
          reviewed: {
            pluginId: "reviewed",
            activeVersion: "1.0.0",
            versions: {
              "1.0.0": {
                pluginId: "reviewed",
                version: "1.0.0",
                source: { type: "local", path: pluginRoot },
                installedRoot: pluginRoot,
                installedAt: "2026-01-01T00:00:00Z",
                permissionsHash: acceptedHash,
                sensitiveApprovals: [],
              },
            },
            approvalsByHash: {},
          },
        },
      };
      await stateStore.write(state);

      const registry = new PluginRegistry({
        installedRoot: root,
        legacyGlobalRoot: root,
        stateStore,
      });
      const result = await registry.list({ enabled: [], disabled: [], directories: [] });

      const reviewed = result.plugins.find((p) => p.pluginId === "reviewed");
      expect(reviewed?.permissionState?.state).toBe("loaded");
      expect(
        result.diagnostics.filter(
          (d) =>
            d.pluginId === "reviewed" &&
            (d.code === "permission_review_required" || d.code === "capability_filtered"),
        ),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a reviewed plugin whose accepted hash differs is needs-review with a permission_review_required diagnostic", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-reg-perm-"));
    try {
      const pluginRoot = await writePlugin(root, "drifted");
      const stateStore = new FilePluginStateStore(join(root, "state.json"));
      const state: PluginStateFile = {
        plugins: {
          drifted: {
            pluginId: "drifted",
            activeVersion: "1.0.0",
            versions: {
              "1.0.0": {
                pluginId: "drifted",
                version: "1.0.0",
                source: { type: "local", path: pluginRoot },
                installedRoot: pluginRoot,
                installedAt: "2026-01-01T00:00:00Z",
                permissionsHash: "stale-hash-that-does-not-match",
                sensitiveApprovals: [],
              },
            },
            approvalsByHash: {},
          },
        },
      };
      await stateStore.write(state);

      const registry = new PluginRegistry({
        installedRoot: root,
        legacyGlobalRoot: root,
        stateStore,
      });
      const result = await registry.list({ enabled: [], disabled: [], directories: [] });

      const drifted = result.plugins.find((p) => p.pluginId === "drifted");
      expect(drifted?.permissionState?.state).toBe("needs-review");
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ pluginId: "drifted", code: "permission_review_required" }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
