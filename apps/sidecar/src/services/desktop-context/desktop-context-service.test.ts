import { describe, expect, test } from "bun:test";
import type { DesktopContextSnapshot } from "@lume/shared";
import { DesktopContextService } from "./desktop-context-service";
import { redactDesktopText } from "./desktop-context-store";

function createService(input: { enabled?: boolean; allowedApps?: string[]; proactiveEnabled?: boolean } = {}) {
  const snapshots = new Map<string, DesktopContextSnapshot>();
  return new DesktopContextService({
    dbPath: "unused.sqlite",
    settings: {
      enabled: input.enabled ?? true,
      allowedApps: input.allowedApps ?? ["wechat.exe"],
      retentionHours: 24,
      maxStorageBytes: 2_000_000,
      proactiveEnabled: input.proactiveEnabled === true,
    },
    createStore: () => ({
      put(snapshot) {
        snapshots.set(snapshot.id, {
          ...snapshot,
          ...(snapshot.visibleText ? { visibleText: redactDesktopText(snapshot.visibleText) } : {}),
        });
      },
      getRedacted: (id) => snapshots.get(id),
      latestRedacted: () => [...snapshots.values()].at(-1),
      recent: () => [...snapshots.values()],
      search: () => [...snapshots.values()],
      purge: () => undefined,
      stats: () => ({ items: snapshots.size, bytes: 0 }),
      clear: () => snapshots.clear(),
      close: () => undefined,
    }),
    invokeHost: async () => ({
      status: "ok",
      snapshot: {
        id: "snap-1",
        app: { id: "wechat.exe", name: "微信" },
        window: {
          id: "win:1",
          appId: "wechat.exe",
          title: "项目群",
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          focused: true,
        },
        capturedAt: 100,
        eventType: "foreground_changed",
        visibleText: "客户问 password=secret 怎么处理",
        untrusted: true,
      },
    }),
  });
}

describe("DesktopContextService", () => {
  test("requires an encryption key before retaining snapshots", async () => {
    const service = createService();
    expect(await service.captureCurrent()).toEqual({
      status: "unavailable",
      message: "desktop context store is locked",
    });
  });

  test("captures allowed apps and returns only a redacted projection", async () => {
    const service = createService();
    service.unlock(Buffer.alloc(32, 4));
    expect(await service.captureCurrent()).toEqual({
      status: "ok",
      snapshotId: "snap-1",
      app: { id: "wechat.exe", name: "微信" },
      window: { id: "win:1", title: "项目群" },
      capturedAt: 100,
    });

    const current = await service.currentContext({ snapshotId: "snap-1" });
    expect(JSON.stringify(current)).not.toContain("secret");
    expect(JSON.stringify(current)).toContain("[REDACTED]");
  });

  test("blocks apps outside the explicit allowlist", async () => {
    const service = createService({ allowedApps: ["chrome.exe"] });
    service.unlock(Buffer.alloc(32, 4));
    expect(await service.captureCurrent()).toEqual({
      status: "blocked",
      message: "desktop context is not allowed for wechat.exe",
    });
  });

  test("does not capture when the desktop assistant is disabled", async () => {
    const service = createService({ enabled: false });
    service.unlock(Buffer.alloc(32, 4));
    expect(await service.captureCurrent()).toEqual({
      status: "unavailable",
      message: "desktop assistant is disabled",
    });
  });

  test("allows a user-initiated one-shot capture without enabling background collection", async () => {
    const service = createService({ enabled: false, allowedApps: ["chrome.exe"] });
    service.unlock(Buffer.alloc(32, 4));

    expect(await service.captureCurrent({ userInitiated: true })).toEqual({
      status: "ok",
      snapshotId: "snap-1",
      app: { id: "wechat.exe", name: "微信" },
      window: { id: "win:1", title: "项目群" },
      capturedAt: 100,
    });
    expect(service.getSettings().enabled).toBe(false);
    expect(JSON.stringify(await service.currentContext({ snapshotId: "snap-1" }))).not.toContain("secret");
  });

  test("creates non-sensitive reply proposals from local context only when proactive mode is enabled", async () => {
    const service = createService({ proactiveEnabled: true });
    service.unlock(Buffer.alloc(32, 4));

    await service.captureCurrent();
    const proposals = service.listProposals();

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.kind).toBe("reply");
    expect(proposals[0]?.status).toBe("pending");
    expect(JSON.stringify(proposals[0])).not.toContain("password=secret");
    expect(JSON.stringify(proposals[0])).not.toContain("客户问");
  });

  test("allows dismissing proactive proposals without deleting the encrypted snapshot", async () => {
    const service = createService({ proactiveEnabled: true });
    service.unlock(Buffer.alloc(32, 4));
    await service.captureCurrent();
    const [proposal] = service.listProposals();

    expect(service.updateProposal(proposal!.id, "dismissed")).toEqual({ updated: true });
    expect(service.listProposals()[0]?.status).toBe("dismissed");
    expect(await service.currentContext({ snapshotId: "snap-1" })).toMatchObject({ status: "ok" });
  });
});
