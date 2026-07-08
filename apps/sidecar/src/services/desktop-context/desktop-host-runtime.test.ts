import { describe, expect, test } from "bun:test";
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
});
