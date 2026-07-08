import { describe, expect, test } from "bun:test";
import type { DesktopContextSnapshot } from "@lume/shared";
import { DesktopContextService } from "./desktop-context-service";
import { redactDesktopText } from "./desktop-context-store";

function createService(input: {
  enabled?: boolean;
  allowedApps?: string[];
  proactiveEnabled?: boolean;
  notificationsEnabled?: boolean;
  emitNotification?: (method: string, params: unknown) => void;
} = {}) {
  const snapshots = new Map<string, DesktopContextSnapshot>();
  return new DesktopContextService({
    dbPath: "unused.sqlite",
    settings: {
      enabled: input.enabled ?? true,
      allowedApps: input.allowedApps ?? ["wechat.exe"],
      retentionHours: 24,
      maxStorageBytes: 2_000_000,
      proactiveEnabled: input.proactiveEnabled === true,
      notificationsEnabled: input.notificationsEnabled,
    },
    emitNotification: input.emitNotification,
    createStore: () => ({
      put(snapshot) {
        snapshots.set(snapshot.id, {
          ...snapshot,
          ...(snapshot.visibleText ? { visibleText: redactDesktopText(snapshot.visibleText) } : {}),
          ...(snapshot.screenshots ? {
            screenshots: snapshot.screenshots.map(({ dataUrl: _dataUrl, ...screenshot }) => screenshot),
          } : {}),
        });
      },
      get: (id) => snapshots.get(id),
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
    const current = await service.currentContext({ snapshotId: "snap-1" });
    expect(current).toMatchObject({ status: "ok" });
    expect(JSON.stringify(current)).not.toContain("secret");
    expect(JSON.stringify(current)).toContain("[REDACTED]");
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

  test("emits a non-sensitive proposal notification only when desktop notifications are enabled", async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const service = createService({
      proactiveEnabled: true,
      notificationsEnabled: true,
      emitNotification: (method, params) => notifications.push({ method, params }),
    });
    service.unlock(Buffer.alloc(32, 4));

    await service.captureCurrent();

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      method: "desktop-context:proposal-created",
      params: {
        proposal: {
          kind: "reply",
          status: "pending",
          app: { id: "wechat.exe", name: "微信" },
        },
      },
    });
    expect(JSON.stringify(notifications)).not.toContain("password=secret");
    expect(JSON.stringify(notifications)).not.toContain("客户问");
    expect(JSON.stringify(notifications)).not.toContain("项目群");
    expect(JSON.stringify(notifications)).not.toContain("可能有一条需要回复");

    const disabledNotifications: Array<{ method: string; params: unknown }> = [];
    const disabledService = createService({
      proactiveEnabled: true,
      notificationsEnabled: false,
      emitNotification: (method, params) => disabledNotifications.push({ method, params }),
    });
    disabledService.unlock(Buffer.alloc(32, 4));
    await disabledService.captureCurrent();

    expect(disabledNotifications).toEqual([]);
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

  test("captures screenshot pixels only for user-initiated current app selection", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const rawSnapshots = new Map<string, DesktopContextSnapshot>();
    const service = new DesktopContextService({
      dbPath: "unused.sqlite",
      settings: {
        enabled: true,
        allowedApps: ["wechat.exe"],
        retentionHours: 24,
        maxStorageBytes: 2_000_000,
        proactiveEnabled: false,
      },
      createStore: () => ({
        put(snapshot) {
          rawSnapshots.set(snapshot.id, snapshot);
        },
        get: (id) => rawSnapshots.get(id),
        getRedacted: (id) => {
          const snapshot = rawSnapshots.get(id);
          return snapshot ? {
            ...snapshot,
            visibleText: snapshot.visibleText ? redactDesktopText(snapshot.visibleText) : undefined,
            screenshots: snapshot.screenshots?.map(({ dataUrl: _dataUrl, ...screenshot }) => screenshot),
          } : undefined;
        },
        latestRedacted: () => undefined,
        recent: () => [],
        search: () => [],
        purge: () => undefined,
        stats: () => ({ items: rawSnapshots.size, bytes: 0 }),
        clear: () => rawSnapshots.clear(),
        close: () => undefined,
      }),
      invokeHost: async (method, params) => {
        calls.push({ method, params });
        return {
          status: "ok",
          snapshot: {
            id: `snap-${calls.length}`,
            app: { id: "wechat.exe", name: "微信" },
            window: {
              id: "win:1",
              appId: "wechat.exe",
              title: "项目群",
              bounds: { x: 0, y: 0, width: 800, height: 600 },
              focused: true,
            },
            capturedAt: 100 + calls.length,
            eventType: "foreground_changed",
            visibleText: "客户问 password=secret 怎么处理",
            screenshots: params.includeScreenshot === true ? [{
              id: "shot-1",
              width: 320,
              height: 200,
              origin: { x: 10, y: 20 },
              mimeType: "image/png",
              dataUrl: "data:image/png;base64,iVBORw0KGgo=",
            }] : undefined,
            untrusted: true,
          },
        };
      },
    });
    service.unlock(Buffer.alloc(32, 8));

    await service.captureCurrent();
    const selected = await service.captureCurrent({ userInitiated: true });
    const current = await service.currentContext({ snapshotId: "snap-2", includeScreenshot: true });

    expect(calls.map((call) => call.params)).toEqual([{}, { includeScreenshot: true }]);
    expect(selected).toMatchObject({ status: "ok", snapshotId: "snap-2" });
    expect(JSON.stringify(current)).toContain("iVBORw0KGgo=");
    expect(JSON.stringify(current)).not.toContain("secret");
  });
});
