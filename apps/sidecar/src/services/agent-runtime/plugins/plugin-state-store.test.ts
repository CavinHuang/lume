import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePluginStateStore } from "./plugin-state-store.js";

describe("FilePluginStateStore", () => {
  test("returns empty state when file is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-plugin-state-"));
    try {
      const store = new FilePluginStateStore(join(root, "plugins-state.json"));
      await expect(store.read()).resolves.toEqual({ plugins: {} });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("writes plugin state atomically enough for callers", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-plugin-state-"));
    try {
      const path = join(root, "plugins-state.json");
      const store = new FilePluginStateStore(path);
      await store.write({
        plugins: {
          alpha: {
            pluginId: "alpha",
            activeVersion: "1.0.0",
            versions: {},
            approvalsByHash: {},
          },
        },
      });
      const raw = JSON.parse(await readFile(path, "utf-8"));
      expect(raw.plugins.alpha.activeVersion).toBe("1.0.0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("appendSensitiveApproval persists a record readable on next read", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-state-append-"));
    try {
      const store = new FilePluginStateStore(join(root, "plugins-state.json"));
      await store.write({
        plugins: {
          demo: {
            pluginId: "demo",
            activeVersion: "1.0.0",
            versions: {
              "1.0.0": {
                pluginId: "demo",
                version: "1.0.0",
                source: { type: "local", path: root },
                installedRoot: root,
                installedAt: "t",
                sensitiveApprovals: [],
                permissionsHash: "h1",
              },
            },
            approvalsByHash: {},
          },
        },
      });
      await store.appendSensitiveApproval({
        pluginId: "demo",
        record: {
          key: "commandTool:demo_echo",
          scope: "workspace",
          workspaceSlug: "ws",
          decision: "allow",
          createdAt: "now",
          permissionsHash: "h1",
        },
      });
      const state = await store.read();
      const approvals = state.plugins.demo?.versions["1.0.0"]?.sensitiveApprovals ?? [];
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.key).toBe("commandTool:demo_echo");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("appendSensitiveApproval throws when plugin is unknown", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-state-append-"));
    try {
      const store = new FilePluginStateStore(join(root, "plugins-state.json"));
      await store.write({ plugins: {} });
      await expect(
        store.appendSensitiveApproval({
          pluginId: "ghost",
          record: {
            key: "commandTool:echo",
            scope: "global",
            decision: "allow",
            createdAt: "now",
            permissionsHash: "h",
          },
        }),
      ).rejects.toThrow(/plugin not found/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("appendSensitiveApproval falls back to approvalsByHash when no activeVersion/external", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-state-append-"));
    try {
      const store = new FilePluginStateStore(join(root, "plugins-state.json"));
      await store.write({
        plugins: {
          bare: {
            pluginId: "bare",
            versions: {},
            approvalsByHash: {},
          },
        },
      });
      await store.appendSensitiveApproval({
        pluginId: "bare",
        record: {
          key: "commandTool:echo",
          scope: "global",
          decision: "allow",
          createdAt: "now",
          permissionsHash: "h9",
        },
      });
      const state = await store.read();
      const bundle = state.plugins.bare?.approvalsByHash["h9"];
      expect(bundle?.sensitiveApprovals).toHaveLength(1);
      expect(bundle?.sensitiveApprovals[0]?.key).toBe("commandTool:echo");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
