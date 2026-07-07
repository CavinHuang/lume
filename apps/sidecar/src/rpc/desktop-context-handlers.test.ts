import { describe, expect, test } from "bun:test";
import { DESKTOP_CONTEXT_IPC_CHANNELS } from "@lume/shared";
import { createDesktopContextHandlers } from "./desktop-context-handlers";

describe("desktop context RPC handlers", () => {
  test("decodes the bootstrap key and delegates non-secret operations", async () => {
    const calls: unknown[] = [];
    const handlers = createDesktopContextHandlers({
      unlock: (key) => calls.push({ unlockBytes: key.length }),
      captureCurrent: async () => ({ status: "ok", snapshotId: "snap-1" }),
      currentContext: async (input) => ({ status: "ok", input }),
      searchContext: async (input) => ({ status: "ok", input }),
      getSettings: () => ({ enabled: false, allowedApps: [], retentionHours: 24, maxStorageBytes: 100 }),
      updateSettings: (settings) => settings,
      getStatus: async () => ({ host: { status: "ok" }, store: { unlocked: true, items: 0, bytes: 0 } }),
      clear: () => ({ cleared: true }),
      listActivity: () => [],
    });

    expect(await handlers[DESKTOP_CONTEXT_IPC_CHANNELS.UNLOCK]?.({ key: Buffer.alloc(32, 1).toString("base64") })).toEqual({ ok: true });
    expect(calls).toEqual([{ unlockBytes: 32 }]);
    expect(await handlers[DESKTOP_CONTEXT_IPC_CHANNELS.CAPTURE_CURRENT]?.({})).toEqual({ status: "ok", snapshotId: "snap-1" });
  });

  test("rejects malformed encryption keys", async () => {
    const handlers = createDesktopContextHandlers({
      unlock: () => undefined,
      captureCurrent: async () => ({}),
      currentContext: async () => ({}),
      searchContext: async () => ({}),
      getSettings: () => ({ enabled: false, allowedApps: [], retentionHours: 24, maxStorageBytes: 100 }),
      updateSettings: (settings) => settings,
      getStatus: async () => ({}),
      clear: () => ({ cleared: true }),
      listActivity: () => [],
    });
    expect(() => handlers[DESKTOP_CONTEXT_IPC_CHANNELS.UNLOCK]?.({ key: "bad" })).toThrow("32-byte");
  });
});
