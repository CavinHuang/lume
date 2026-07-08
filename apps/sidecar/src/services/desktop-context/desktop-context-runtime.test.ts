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
});
