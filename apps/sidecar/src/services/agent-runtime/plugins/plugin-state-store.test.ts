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
});
