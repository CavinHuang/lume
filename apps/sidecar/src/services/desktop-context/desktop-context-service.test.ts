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
  snapshot?: DesktopContextSnapshot;
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
      snapshot: input.snapshot ?? {
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
  test("reads foreground target metadata without unlocking or collecting window content", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const service = new DesktopContextService({
      dbPath: "unused.sqlite",
      settings: {
        enabled: false,
        allowedApps: [],
        retentionHours: 24,
        maxStorageBytes: 2_000_000,
      },
      createStore: () => {
        throw new Error("metadata lookup must not open the context store");
      },
      invokeHost: async (method, params) => {
        calls.push({ method, params });
        return {
          status: "ok",
          window: {
            id: "win:wechat",
            appId: "wechat.exe",
            appName: "微信",
            title: "项目群",
            focused: true,
          },
        };
      },
    });

    expect(await service.getForegroundTarget()).toEqual({
      status: "ok",
      app: { id: "wechat.exe", name: "微信" },
      window: { id: "win:wechat", title: "项目群" },
    });
    expect(calls).toEqual([{ method: "get_window", params: {} }]);
  });

  test("captures a remembered exact window only after a user opens desktop context", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const snapshots = new Map<string, DesktopContextSnapshot>();
    const service = new DesktopContextService({
      dbPath: "unused.sqlite",
      settings: {
        enabled: false,
        allowedApps: [],
        retentionHours: 24,
        maxStorageBytes: 2_000_000,
      },
      createStore: () => ({
        put: (snapshot) => snapshots.set(snapshot.id, snapshot),
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
      invokeHost: async (method, params) => {
        calls.push({ method, params });
        return {
          status: "ok",
          revision: "rev-wechat",
          capturedAt: 200,
          window: {
            id: "win:wechat",
            appId: "wechat.exe",
            appName: "微信",
            title: "项目群",
            bounds: { x: 0, y: 0, width: 800, height: 600 },
            focused: false,
          },
          accessibility: {
            documentText: "这个问题怎么回复？",
          },
          screenshots: [{
            id: "shot-wechat",
            width: 800,
            height: 600,
            origin: { x: 0, y: 0 },
            mimeType: "image/png",
            dataUrl: "data:image/png;base64,iVBORw0KGgo=",
          }],
        };
      },
    });
    service.unlock(Buffer.alloc(32, 7));

    expect(await service.captureWindow({
      windowId: "win:wechat",
      userInitiated: true,
    })).toEqual({
      status: "ok",
      snapshotId: "window:win:wechat:200",
      app: { id: "wechat.exe", name: "微信" },
      window: { id: "win:wechat", title: "项目群" },
      capturedAt: 200,
    });
    expect(calls).toEqual([{
      method: "get_window_state",
      params: { windowId: "win:wechat", includeScreenshot: true },
    }]);
    expect(snapshots.get("window:win:wechat:200")).toMatchObject({
      visibleText: "这个问题怎么回复？",
      untrusted: true,
    });
  });

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

  test("turns macOS permission diagnostics into an actionable capture message", async () => {
    const service = new DesktopContextService({
      dbPath: "unused.sqlite",
      settings: {
        enabled: true,
        allowedApps: [],
        retentionHours: 24,
        maxStorageBytes: 2_000_000,
      },
      createStore: () => {
        throw new Error("store should not be used for permission diagnostics");
      },
      invokeHost: async () => ({
        status: "permission_denied",
        permissionTarget: {
          appName: "Lume Computer Use",
          appBundleName: "Lume Computer Use.app",
          bundleId: "com.lume.computer-use",
        },
        permissions: [
          { id: "accessibility", title: "Accessibility", status: "missing" },
          { id: "screenRecording", title: "Screen & System Audio Recording", status: "missing" },
        ],
      }),
    });
    service.unlock(Buffer.alloc(32, 5));

    expect(await service.captureCurrent({ userInitiated: true })).toMatchObject({
      status: "permission_denied",
      message: "需要在 macOS 系统设置中授权 Lume Computer Use.app：Accessibility、Screen & System Audio Recording。请授权 computer use 包，而不是 Lume 主应用。",
      permissionTarget: {
        appBundleName: "Lume Computer Use.app",
        bundleId: "com.lume.computer-use",
      },
    });
  });

  test("includes the macOS computer-use permission target in status diagnostics", async () => {
    const calls: string[] = [];
    const service = new DesktopContextService({
      dbPath: "unused.sqlite",
      settings: {
        enabled: true,
        allowedApps: [],
        retentionHours: 24,
        maxStorageBytes: 2_000_000,
      },
      invokeHost: async (method) => {
        calls.push(method);
        if (method === "diagnose_permissions") {
          return {
            status: "permission_denied",
            message: "missing macOS permissions",
            permissionTarget: {
              appName: "Lume Computer Use",
              appBundleName: "Lume Computer Use.app",
              bundleId: "com.lume.computer-use",
              authorizationSubject: "appBundle",
            },
            permissions: [
              { id: "accessibility", title: "Accessibility", status: "missing" },
              { id: "screenRecording", title: "Screen & System Audio Recording", status: "granted" },
            ],
          };
        }
        throw new Error(`unexpected host method: ${method}`);
      },
    });

    expect(await service.getStatus()).toEqual({
      host: {
        status: "permission_denied",
        message: "missing macOS permissions",
        permissionTarget: {
          appName: "Lume Computer Use",
          appBundleName: "Lume Computer Use.app",
          bundleId: "com.lume.computer-use",
          authorizationSubject: "appBundle",
        },
        permissions: [
          { id: "accessibility", title: "Accessibility", status: "missing" },
          { id: "screenRecording", title: "Screen & System Audio Recording", status: "granted" },
        ],
      },
      store: { unlocked: false, items: 0, bytes: 0 },
    });
    expect(calls).toEqual(["diagnose_permissions"]);
  });

  test("advances through macOS permissions and waits until the computer-use app is ready", async () => {
    const calls: string[] = [];
    const service = new DesktopContextService({
      dbPath: "unused.sqlite",
      settings: {
        enabled: true,
        allowedApps: [],
        retentionHours: 24,
        maxStorageBytes: 2_000_000,
      },
      invokeHost: async (method) => {
        calls.push(method);
        if (calls.length === 1) {
          return {
            status: "permission_denied",
            permissionTarget: { appBundleName: "Lume Computer Use.app" },
            nextPermission: { id: "accessibility", title: "Accessibility" },
          };
        }
        if (calls.length === 2) {
          return {
            status: "permission_denied",
            permissionTarget: { appBundleName: "Lume Computer Use.app" },
            nextPermission: { id: "screenRecording", title: "Screen & System Audio Recording" },
          };
        }
        if (calls.length === 3) {
          return {
            status: "permission_denied",
            permissionTarget: { appBundleName: "Lume Computer Use.app" },
            nextPermission: { id: "screenRecording", title: "Screen & System Audio Recording" },
          };
        }
        return {
          status: "ok",
          permissionTarget: { appBundleName: "Lume Computer Use.app" },
          permissions: [
            { id: "accessibility", status: "granted" },
            { id: "screenRecording", status: "granted" },
          ],
        };
      },
    });

    expect(await service.requestPermissions()).toMatchObject({
      status: "ok",
      message: "Lume Computer Use.app 已获得桌面控制权限。",
    });
    expect(calls).toEqual([
      "request_permissions",
      "diagnose_permissions",
      "request_permissions",
      "diagnose_permissions",
    ]);
  });

  test("normalizes an already-authorized computer-use app to the completed state", async () => {
    const service = new DesktopContextService({
      dbPath: "unused.sqlite",
      settings: {
        enabled: true,
        allowedApps: [],
        retentionHours: 24,
        maxStorageBytes: 2_000_000,
      },
      invokeHost: async () => ({
        status: "ok",
        message: "macOS permission request was started",
        permissionTarget: { appBundleName: "Lume Computer Use (Dev).app" },
      }),
    });

    expect(await service.requestPermissions()).toMatchObject({
      status: "ok",
      message: "Lume Computer Use (Dev).app 已获得桌面控制权限。",
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

  test("does not retain Lume itself as a selectable desktop context", async () => {
    const snapshots = new Map<string, DesktopContextSnapshot>();
    const service = new DesktopContextService({
      dbPath: "unused.sqlite",
      settings: {
        enabled: true,
        allowedApps: [],
        retentionHours: 24,
        maxStorageBytes: 2_000_000,
        proactiveEnabled: true,
      },
      createStore: () => ({
        put(snapshot) {
          snapshots.set(snapshot.id, snapshot);
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
          id: "snap-lume",
          app: { id: "lume.exe", name: "Lume" },
          window: {
            id: "win:lume",
            appId: "lume.exe",
            title: "Lume Quick Input",
            bounds: { x: 0, y: 0, width: 800, height: 600 },
            focused: true,
          },
          capturedAt: 123,
          eventType: "foreground_changed",
          visibleText: "Lume 输入框",
          untrusted: true,
        },
      }),
    });
    service.unlock(Buffer.alloc(32, 7));

    expect(await service.captureCurrent({ userInitiated: true })).toEqual({
      status: "unavailable",
      message: "当前前台窗口是 Lume，请切回目标应用后再唤起或附加上下文。",
    });
    expect(snapshots.size).toBe(0);
    expect(service.listProposals()).toEqual([]);
  });

  test("does not block unrelated apps whose names contain lume", async () => {
    const service = createService({
      allowedApps: [],
      snapshot: {
        id: "snap-lume-notes",
        app: { id: "com.example.lume-notes", name: "Lume Notes" },
        window: {
          id: "win:lume-notes",
          appId: "com.example.lume-notes",
          title: "Weekly Plan",
          bounds: { x: 0, y: 0, width: 900, height: 640 },
          focused: true,
        },
        capturedAt: 456,
        eventType: "foreground_changed",
        visibleText: "本周计划",
        untrusted: true,
      },
    });
    service.unlock(Buffer.alloc(32, 8));

    expect(await service.captureCurrent({ userInitiated: true })).toEqual({
      status: "ok",
      snapshotId: "snap-lume-notes",
      app: { id: "com.example.lume-notes", name: "Lume Notes" },
      window: { id: "win:lume-notes", title: "Weekly Plan" },
      capturedAt: 456,
    });
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

  test("refreshes a retained snapshot from its original window instead of the foreground app", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const snapshots = new Map<string, DesktopContextSnapshot>();
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
          snapshots.set(snapshot.id, {
            ...snapshot,
            ...(snapshot.selectedText ? { selectedText: redactDesktopText(snapshot.selectedText) } : {}),
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
      invokeHost: async (method, params) => {
        calls.push({ method, params });
        if (method === "get_window_state") {
          return {
            status: "ok",
            revision: "rev-2",
            capturedAt: 200,
            window: {
              id: "win:1",
              appId: "wechat.exe",
              appName: "微信",
              title: "项目群",
              bounds: { x: 0, y: 0, width: 800, height: 600 },
              focused: false,
            },
            accessibility: {
              selectedText: "选中 password=secret",
              documentText: "新的客户问题 password=secret 怎么回复",
            },
            screenshots: params.includeScreenshot === true ? [{
              id: "shot-refresh",
              width: 320,
              height: 200,
              origin: { x: 10, y: 20 },
              mimeType: "image/png",
              dataUrl: "data:image/png;base64,iVBORw0KGgo=",
            }] : undefined,
          };
        }
        return {
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
            visibleText: "旧消息",
            untrusted: true,
          },
        };
      },
    });
    service.unlock(Buffer.alloc(32, 9));

    await service.captureCurrent({ userInitiated: true });
    const refreshed = await service.currentContext({ snapshotId: "snap-1", refresh: true, includeScreenshot: true });

    expect(calls.map((call) => call.method)).toEqual(["current_context", "get_window_state"]);
    expect(calls[1]?.params).toEqual({ windowId: "win:1", includeScreenshot: true });
    expect(refreshed).toMatchObject({
      status: "ok",
      snapshot: {
        id: "refresh:snap-1:200",
        app: { id: "wechat.exe", name: "微信" },
        window: { id: "win:1", title: "项目群" },
        capturedAt: 200,
        selectedText: "选中 password=[REDACTED]",
        visibleText: "新的客户问题 password=[REDACTED] 怎么回复",
      },
    });
    expect(JSON.stringify(refreshed)).not.toContain("secret");
  });
});
