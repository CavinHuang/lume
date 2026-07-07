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
