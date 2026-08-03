import { describe, expect, test } from "bun:test";
import { AgentLifecycleLockManager } from "./agent-lifecycle-lock-manager";

describe("AgentLifecycleLockManager", () => {
  test("serializes overlapping workspace and thread resources", async () => {
    const manager = new AgentLifecycleLockManager();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = manager.runExclusive(["thread:b", "workspace:a"], async () => {
      order.push("first:start");
      expect(manager.isHeld("workspace:a")).toBe(true);
      expect(manager.isHeld("thread:b")).toBe(true);
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      order.push("first:end");
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const second = manager.runExclusive(["workspace:a", "thread:c"], async () => { order.push("second"); });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(manager.isHeld("workspace:a")).toBe(false);
  });

  test("reserves synchronous deletion resources without racing queued work", () => {
    const manager = new AgentLifecycleLockManager();
    const release = manager.tryAcquire(["thread:a", "workspace:a"]);
    expect(release).toBeDefined();
    expect(manager.tryAcquire(["workspace:a"])).toBeUndefined();
    release!();
    expect(manager.tryAcquire(["workspace:a"])).toBeDefined();
  });
});
