import { describe, expect, test } from "bun:test";
import { clearThreadFileStateCache, getThreadFileStateCache } from "./thread-file-state-cache";

describe("thread file state cache registry", () => {
  test("returns one shared instance per thread and drops it on clear", () => {
    const first = getThreadFileStateCache("thread-a");
    expect(getThreadFileStateCache("thread-a")).toBe(first);
    expect(getThreadFileStateCache("thread-b")).not.toBe(first);

    clearThreadFileStateCache("thread-a");
    expect(getThreadFileStateCache("thread-a")).not.toBe(first);
  });
});
