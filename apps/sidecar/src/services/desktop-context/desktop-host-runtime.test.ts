import { describe, expect, test } from "bun:test";
import { DesktopHostRequestError } from "./desktop-host-client";
import { createDesktopHostInvoker } from "./desktop-host-runtime";

describe("createDesktopHostInvoker", () => {
  test("returns unavailable when Electron did not provide connection metadata", async () => {
    const invoke = createDesktopHostInvoker({ env: {} });
    await expect(invoke("list_apps", {})).resolves.toEqual({
      status: "unavailable",
      message: "Lume desktop host is not configured",
    });
  });

  test("returns actionable permission diagnostics without a configured host", async () => {
    const invoke = createDesktopHostInvoker({ env: {} });
    await expect(invoke("diagnose_permissions", {})).resolves.toMatchObject({
      status: "unavailable",
      permissionTarget: {
        appName: "Lume Computer Use",
        appBundleName: "Lume Computer Use.app",
        bundleId: "com.lume.computer-use",
        authorizationSubject: "appBundle",
      },
      permissions: [
        { id: "accessibility", status: "unknown" },
        { id: "screenRecording", status: "unknown" },
      ],
    });
  });

  test("reuses one client and forwards host methods", async () => {
    const calls: unknown[] = [];
    let clients = 0;
    const invoke = createDesktopHostInvoker({
      env: {
        LUME_DESKTOP_HOST_ENDPOINT: "desktop-endpoint",
        LUME_DESKTOP_HOST_TOKEN: "desktop-token",
      },
      createClient: (options) => {
        clients += 1;
        expect(options).toEqual({ endpoint: "desktop-endpoint", token: "desktop-token" });
        return {
          call: async (method, params) => {
            calls.push({ method, params });
            return { status: "ok" };
          },
        };
      },
    });

    await invoke("list_apps", {});
    await invoke("list_windows", { appId: "wechat" });
    expect(clients).toBe(1);
    expect(calls).toEqual([
      { method: "list_apps", params: {} },
      { method: "list_windows", params: { appId: "wechat" } },
    ]);
  });

  test("forwards authenticated host notifications to context listeners", async () => {
    let notify: ((method: string, params: unknown) => void) | undefined;
    const invoke = createDesktopHostInvoker({
      env: { LUME_DESKTOP_HOST_ENDPOINT: "endpoint", LUME_DESKTOP_HOST_TOKEN: "token" },
      createClient: () => ({
        call: async () => ({ status: "ok" }),
        onNotification(listener) {
          notify = listener;
          return () => { notify = undefined; };
        },
      }),
    });
    const events: unknown[] = [];
    invoke.onNotification((method, params) => events.push({ method, params }));

    await invoke("list_apps", {});
    notify?.("context.event", { type: "foreground_changed" });
    expect(events).toEqual([{
      method: "context.event",
      params: { type: "foreground_changed" },
    }]);
  });

  test("converts connection failures into an explicit unavailable result", async () => {
    const invoke = createDesktopHostInvoker({
      env: { LUME_DESKTOP_HOST_ENDPOINT: "endpoint", LUME_DESKTOP_HOST_TOKEN: "token" },
      createClient: () => ({ call: async () => { throw new Error("pipe closed"); } }),
    });
    await expect(invoke("list_apps", {})).resolves.toEqual({
      status: "unavailable",
      message: "desktop host connection failed: pipe closed",
    });
  });

  test("preserves authenticated host request errors", async () => {
    const invoke = createDesktopHostInvoker({
      env: {
        LUME_DESKTOP_HOST_ENDPOINT: "endpoint",
        LUME_DESKTOP_HOST_TOKEN: "token",
      },
      createClient: () => ({
        call: async () => {
          throw new DesktopHostRequestError(
            "stale_target: use the latest state.window",
            -32000,
          );
        },
      }),
    });

    await expect(invoke("click", {})).rejects.toMatchObject({
      code: -32000,
      message: "stale_target: use the latest state.window",
    });
  });
});
