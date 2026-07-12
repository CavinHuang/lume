import { describe, expect, test } from "bun:test";
import { resolveDesktopContextProjection } from "./desktop-context-runtime";

describe("resolveDesktopContextProjection", () => {
  test("resolves only the requested redacted snapshot", async () => {
    const calls: unknown[] = [];
    const result = await resolveDesktopContextProjection(
      { desktopContextSnapshotId: "snapshot-1" },
      {
        currentContext: async (input) => {
          calls.push(input);
          return {
            status: "ok",
            snapshot: { id: "snapshot-1", visibleText: "redacted" },
          };
        },
      },
    );

    expect(calls).toEqual([{ snapshotId: "snapshot-1", includeScreenshot: true }]);
    expect(result).toEqual({
      snapshot: { id: "snapshot-1", visibleText: "redacted" },
    });
  });

  test("resolves retained screenshot pixels as non-persistent image blocks", async () => {
    const result = await resolveDesktopContextProjection(
      { desktopContextSnapshotId: "snapshot-image" },
      {
        currentContext: async (input) => {
          expect(input).toEqual({ snapshotId: "snapshot-image", includeScreenshot: true });
          return {
            status: "ok",
            snapshot: {
              id: "snapshot-image",
              screenshots: [{
                id: "shot-1",
                width: 320,
                height: 200,
                origin: { x: 10, y: 20 },
                mimeType: "image/png",
                dataUrl: "data:image/png;base64,iVBORw0KGgo=",
              }],
              visibleText: "redacted",
            },
          };
        },
      },
    );

    expect(result).toEqual({
      snapshot: {
        id: "snapshot-image",
        screenshots: [{
          id: "shot-1",
          width: 320,
          height: 200,
          origin: { x: 10, y: 20 },
          mimeType: "image/png",
        }],
        visibleText: "redacted",
      },
      imageBlocks: [{
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
        _meta: { screenshotId: "shot-1", persist: false },
      }],
    });
  });

  test("does not query without a valid snapshot id", async () => {
    let called = false;
    const result = await resolveDesktopContextProjection(
      { desktopContextSnapshotId: 42 },
      {
        currentContext: async () => {
          called = true;
          return { status: "ok" };
        },
      },
    );

    expect(called).toBe(false);
    expect(result).toBeUndefined();
  });

  test("omits unavailable context instead of failing the run", async () => {
    const result = await resolveDesktopContextProjection(
      { desktopContextSnapshotId: "expired" },
      {
        currentContext: async () => ({ status: "unavailable" }),
      },
    );

    expect(result).toBeUndefined();
  });

  test("refreshes an expired snapshot from the desktop window retained in message metadata", async () => {
    const hostCalls: unknown[] = [];
    const result = await resolveDesktopContextProjection(
      {
        desktopContextSnapshotId: "expired",
        desktopApp: { id: "wechat.exe", name: "微信" },
        desktopWindow: { id: "win:wechat", title: "项目群" },
      },
      {
        currentContext: async () => ({ status: "unavailable" }),
      },
      async (method, input) => {
        hostCalls.push({ method, input });
        return {
          status: "ok",
          capturedAt: 200,
          window: { id: "win:wechat", appId: "wechat.exe", title: "项目群", focused: true },
          screenshots: [{
            id: "shot-fresh",
            width: 640,
            height: 480,
            origin: { x: 0, y: 0 },
            mimeType: "image/png",
            dataUrl: "data:image/png;base64,iVBORw0KGgo=",
          }],
          accessibility: {
            selectedText: "客户的问题",
            documentText: "客户问今天能不能交付",
          },
        };
      },
    );

    expect(hostCalls).toEqual([{
      method: "get_window_state",
      input: { windowId: "win:wechat", includeScreenshot: true },
    }]);
    expect(result).toEqual({
      snapshot: {
        id: "expired",
        app: { id: "wechat.exe", name: "微信" },
        window: { id: "win:wechat", appId: "wechat.exe", title: "项目群", focused: true },
        capturedAt: 200,
        selectedText: "客户的问题",
        visibleText: "客户问今天能不能交付",
        screenshots: [{
          id: "shot-fresh",
          width: 640,
          height: 480,
          origin: { x: 0, y: 0 },
          mimeType: "image/png",
        }],
        untrusted: true,
      },
      imageBlocks: [{
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
        _meta: { screenshotId: "shot-fresh", persist: false },
      }],
    });
  });

  test("rejects expired snapshot fallback when the retained window now belongs to another app", async () => {
    const hostCalls: unknown[] = [];
    const result = await resolveDesktopContextProjection(
      {
        desktopContextSnapshotId: "expired",
        desktopApp: { id: "wechat.exe", name: "微信" },
        desktopWindow: { id: "win:wechat", title: "项目群" },
      },
      {
        currentContext: async () => ({ status: "unavailable" }),
      },
      async (method, input) => {
        hostCalls.push({ method, input });
        return {
          status: "ok",
          capturedAt: 300,
          window: { id: "win:wechat", appId: "notes.exe", title: "项目群", focused: true },
          accessibility: { documentText: "另一个应用的内容" },
        };
      },
    );

    expect(hostCalls).toEqual([{
      method: "get_window_state",
      input: { windowId: "win:wechat", includeScreenshot: true },
    }]);
    expect(result).toBeUndefined();
  });
});
