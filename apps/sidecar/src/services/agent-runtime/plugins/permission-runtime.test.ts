import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePluginStateStore, type PluginStateFile } from "./plugin-state-store.js";
import { PluginPermissionRuntime } from "./permission-runtime.js";

async function withRuntime<T>(
  fn: (runtime: PluginPermissionRuntime, store: FilePluginStateStore) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "lume-perm-runtime-"));
  const store = new FilePluginStateStore(join(dir, "state.json"));
  const runtime = new PluginPermissionRuntime({ stateStore: store });
  try {
    return await fn(runtime, store);
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  }
}

function stateWith(
  pluginId: string,
  partial: Partial<PluginStateFile["plugins"][string]>,
): PluginStateFile {
  return {
    plugins: {
      [pluginId]: {
        pluginId,
        versions: {},
        approvalsByHash: {},
        ...partial,
      },
    },
  };
}

describe("PluginPermissionRuntime.checkSensitiveCapability", () => {
  test("returns ask when there is no install record", async () => {
    await withRuntime(async (runtime) => {
      const result = await runtime.checkSensitiveCapability({
        pluginId: "ghost",
        key: "commandTool:echo",
      });
      expect(result.decision).toBe("ask");
    });
  });

  test("returns allow when an activeVersion has an allow approval", async () => {
    await withRuntime(async (runtime, store) => {
      await store.write(
        stateWith("acme", {
          activeVersion: "1.0.0",
          versions: {
            "1.0.0": {
              pluginId: "acme",
              version: "1.0.0",
              source: { type: "local", path: "/p" },
              installedRoot: "/p",
              installedAt: "2026-01-01T00:00:00Z",
              permissionsHash: "h",
              sensitiveApprovals: [
                { key: "commandTool:echo", scope: "global", decision: "allow", createdAt: "2026-01-01T00:00:00Z", permissionsHash: "h" },
              ],
            },
          },
        }),
      );
      const result = await runtime.checkSensitiveCapability({
        pluginId: "acme",
        key: "commandTool:echo",
      });
      expect(result.decision).toBe("allow");
    });
  });

  test("ignores an allow recorded under a different permissions hash (#344)", async () => {
    await withRuntime(async (runtime, store) => {
      await store.write(
        stateWith("acme", {
          // Accepted hash moved on to h2; the merged record still carries an
          // allow that was granted while h1 was current.
          activeVersion: "2.0.0",
          versions: {
            "2.0.0": {
              pluginId: "acme",
              version: "2.0.0",
              source: { type: "local", path: "/p" },
              installedRoot: "/p",
              installedAt: "2026-01-02T00:00:00Z",
              permissionsHash: "h2",
              sensitiveApprovals: [],
            },
          },
          approvalsByHash: {
            h1: {
              permissionsHash: "h1",
              sensitiveApprovals: [
                { key: "commandTool:echo", scope: "global", decision: "allow", createdAt: "2026-01-01T00:00:00Z", permissionsHash: "h1" },
              ],
            },
          },
        }),
      );
      const result = await runtime.checkSensitiveCapability({
        pluginId: "acme",
        key: "commandTool:echo",
      });
      expect(result.decision).toBe("ask");
    });
  });

  test("treats empty-hash approvals as wildcards for legacy records (#344)", async () => {
    await withRuntime(async (runtime, store) => {
      await store.write(
        stateWith("acme", {
          activeVersion: "1.0.0",
          versions: {
            "1.0.0": {
              pluginId: "acme",
              version: "1.0.0",
              source: { type: "local", path: "/p" },
              installedRoot: "/p",
              installedAt: "2026-01-01T00:00:00Z",
              permissionsHash: "h",
              sensitiveApprovals: [
                { key: "commandTool:echo", scope: "global", decision: "allow", createdAt: "2026-01-01T00:00:00Z", permissionsHash: "" },
              ],
            },
          },
        }),
      );
      const result = await runtime.checkSensitiveCapability({
        pluginId: "acme",
        key: "commandTool:echo",
      });
      expect(result.decision).toBe("allow");
    });
  });

  test("surfaces the accepted permissions hash so allow_always records can be stamped (#344 follow-up)", async () => {
    await withRuntime(async (runtime, store) => {
      await store.write(
        stateWith("acme", {
          activeVersion: "1.0.0",
          versions: {
            "1.0.0": {
              pluginId: "acme",
              version: "1.0.0",
              source: { type: "local", path: "/p" },
              installedRoot: "/p",
              installedAt: "2026-01-01T00:00:00Z",
              permissionsHash: "h",
              sensitiveApprovals: [],
            },
          },
        }),
      );
      const result = await runtime.checkSensitiveCapability({
        pluginId: "acme",
        key: "commandTool:echo",
      });
      expect(result.permissionsHash).toBe("h");
    });
  });

  test("still honors a deny from the current hash even when an older allow exists (#344)", async () => {
    await withRuntime(async (runtime, store) => {
      await store.write(
        stateWith("acme", {
          activeVersion: "2.0.0",
          versions: {
            "2.0.0": {
              pluginId: "acme",
              version: "2.0.0",
              source: { type: "local", path: "/p" },
              installedRoot: "/p",
              installedAt: "2026-01-02T00:00:00Z",
              permissionsHash: "h2",
              sensitiveApprovals: [
                { key: "commandTool:echo", scope: "workspace", workspaceSlug: "ws", decision: "deny", createdAt: "2026-01-02T00:00:00Z", permissionsHash: "h2" },
              ],
            },
          },
          approvalsByHash: {
            h1: {
              permissionsHash: "h1",
              sensitiveApprovals: [
                { key: "commandTool:echo", scope: "global", decision: "allow", createdAt: "2026-01-01T00:00:00Z", permissionsHash: "" },
              ],
            },
          },
        }),
      );
      const result = await runtime.checkSensitiveCapability({
        pluginId: "acme",
        key: "commandTool:echo",
        workspaceSlug: "ws",
      });
      expect(result.decision).toBe("deny");
    });
  });
});

describe("PluginPermissionRuntime.appendSensitiveApproval", () => {
  test("appended allow record flips a follow-up check from ask to allow", async () => {
    await withRuntime(async (runtime, store) => {
      await store.write(
        stateWith("acme", {
          activeVersion: "1.0.0",
          versions: {
            "1.0.0": {
              pluginId: "acme",
              version: "1.0.0",
              source: { type: "local", path: "/p" },
              installedRoot: "/p",
              installedAt: "2026-01-01T00:00:00Z",
              permissionsHash: "h",
              sensitiveApprovals: [],
            },
          },
        }),
      );
      // Before append: no prior approval → ask.
      const before = await runtime.checkSensitiveCapability({
        pluginId: "acme",
        key: "commandTool:echo",
      });
      expect(before.decision).toBe("ask");

      // Append an allow record via the runtime wrapper.
      await runtime.appendSensitiveApproval({
        pluginId: "acme",
        record: {
          key: "commandTool:echo",
          scope: "global",
          decision: "allow",
          createdAt: "2026-06-17T00:00:00Z",
          permissionsHash: "h",
        },
      });

      // After append: same source collectSensitiveApprovals reads → allow.
      const after = await runtime.checkSensitiveCapability({
        pluginId: "acme",
        key: "commandTool:echo",
      });
      expect(after.decision).toBe("allow");
    });
  });
});

describe("PluginPermissionRuntime.computeRuntimeState", () => {
  test("not-loaded when no review state exists", async () => {
    await withRuntime(async (runtime) => {
      const result = await runtime.computeRuntimeState({
        pluginId: "ghost",
        enabled: true,
        currentHash: "h",
      });
      expect(result.state).toBe("not-loaded");
    });
  });

  test("loaded when activeVersion hash matches current", async () => {
    await withRuntime(async (runtime, store) => {
      await store.write(
        stateWith("acme", {
          activeVersion: "1.0.0",
          versions: {
            "1.0.0": {
              pluginId: "acme",
              version: "1.0.0",
              source: { type: "local", path: "/p" },
              installedRoot: "/p",
              installedAt: "2026-01-01T00:00:00Z",
              permissionsHash: "h-current",
              sensitiveApprovals: [],
            },
          },
        }),
      );
      const result = await runtime.computeRuntimeState({
        pluginId: "acme",
        enabled: true,
        currentHash: "h-current",
      });
      expect(result.state).toBe("loaded");
    });
  });

  test("needs-review when activeVersion hash differs from current", async () => {
    await withRuntime(async (runtime, store) => {
      await store.write(
        stateWith("acme", {
          activeVersion: "1.0.0",
          versions: {
            "1.0.0": {
              pluginId: "acme",
              version: "1.0.0",
              source: { type: "local", path: "/p" },
              installedRoot: "/p",
              installedAt: "2026-01-01T00:00:00Z",
              permissionsHash: "h-old",
              sensitiveApprovals: [],
            },
          },
        }),
      );
      const result = await runtime.computeRuntimeState({
        pluginId: "acme",
        enabled: true,
        currentHash: "h-new",
      });
      expect(result.state).toBe("needs-review");
    });
  });
});
