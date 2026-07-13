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

    expect(calls).toEqual([{ snapshotId: "snapshot-1" }]);
    expect(result).toEqual({
      snapshot: { id: "snapshot-1", visibleText: "redacted" },
    });
  });

  test("does not inject retained screenshot pixels into first-turn context", async () => {
    const result = await resolveDesktopContextProjection(
      { desktopContextSnapshotId: "snapshot-image" },
      {
        currentContext: async (input) => {
          expect(input).toEqual({ snapshotId: "snapshot-image" });
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

  test("does not reinterpret an expired legacy win binding as a canonical target", async () => {
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
      async (method, input) => { hostCalls.push({ method, input }); return { status: "ok" }; },
    );

    expect(hostCalls).toEqual([]);
    expect(result).toBeUndefined();
  });
});
