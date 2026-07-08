import { describe, expect, test } from "bun:test";
import { DESKTOP_CONTEXT_IPC_CHANNELS } from "@lume/shared";
import { createDesktopContextHandlers } from "./desktop-context-handlers";

describe("desktop context RPC handlers", () => {
  test("decodes the bootstrap key and delegates non-secret operations", async () => {
    const calls: unknown[] = [];
    const handlers = createDesktopContextHandlers({
      unlock: (key) => calls.push({ unlockBytes: key.length }),
      captureCurrent: async (input) => {
        calls.push({ captureCurrent: input });
        return { status: "ok", snapshotId: "snap-1" };
      },
      requestPermissions: async () => {
        calls.push({ requestPermissions: true });
        return { status: "permission_denied" };
      },
      currentContext: async (input) => ({ status: "ok", input }),
      searchContext: async (input) => ({ status: "ok", input }),
      getSettings: () => ({ enabled: false, allowedApps: [], retentionHours: 24, maxStorageBytes: 100 }),
      updateSettings: (settings) => settings,
      getStatus: async () => ({ host: { status: "ok" }, store: { unlocked: true, items: 0, bytes: 0 } }),
      clear: () => ({ cleared: true }),
      listActivity: () => [],
      listProposals: () => [{ id: "proposal-1", status: "pending" }],
      updateProposal: (id, status) => ({ id, status }),
    });

    expect(await handlers[DESKTOP_CONTEXT_IPC_CHANNELS.UNLOCK]?.({ key: Buffer.alloc(32, 1).toString("base64") })).toEqual({ ok: true });
    expect(calls).toEqual([{ unlockBytes: 32 }]);
    expect(await handlers[DESKTOP_CONTEXT_IPC_CHANNELS.CAPTURE_CURRENT]?.({ userInitiated: true })).toEqual({ status: "ok", snapshotId: "snap-1" });
    expect(calls.at(-1)).toEqual({ captureCurrent: { userInitiated: true } });
    expect(await handlers[DESKTOP_CONTEXT_IPC_CHANNELS.REQUEST_PERMISSIONS]?.({})).toEqual({ status: "permission_denied" });
    expect(calls.at(-1)).toEqual({ requestPermissions: true });
    expect(await handlers[DESKTOP_CONTEXT_IPC_CHANNELS.GET_CURRENT]?.({
      snapshotId: "snap-1",
      includeScreenshot: true,
      refresh: true,
    })).toEqual({
      status: "ok",
      input: { snapshotId: "snap-1", includeScreenshot: true, refresh: true },
    });
    expect(await handlers[DESKTOP_CONTEXT_IPC_CHANNELS.LIST_PROPOSALS]?.({})).toEqual([{ id: "proposal-1", status: "pending" }]);
    expect(await handlers[DESKTOP_CONTEXT_IPC_CHANNELS.UPDATE_PROPOSAL]?.({ id: "proposal-1", status: "dismissed" })).toEqual({
      id: "proposal-1",
      status: "dismissed",
    });
  });

  test("rejects malformed encryption keys", async () => {
    const handlers = createDesktopContextHandlers({
      unlock: () => undefined,
      captureCurrent: async () => ({}),
      requestPermissions: async () => ({}),
      currentContext: async () => ({}),
      searchContext: async () => ({}),
      getSettings: () => ({ enabled: false, allowedApps: [], retentionHours: 24, maxStorageBytes: 100 }),
      updateSettings: (settings) => settings,
      getStatus: async () => ({}),
      clear: () => ({ cleared: true }),
      listActivity: () => [],
      listProposals: () => [],
      updateProposal: () => ({ updated: false }),
    });
    expect(() => handlers[DESKTOP_CONTEXT_IPC_CHANNELS.UNLOCK]?.({ key: "bad" })).toThrow("32-byte");
  });
});
