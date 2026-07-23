import { describe, expect, test } from "bun:test";
import { acquireWorkspaceWriterLease } from "./workspace-writer-lease";

describe("workspace writer lease", () => {
  test("serializes competing owners for one workspace", async () => {
    const first = await acquireWorkspaceWriterLease("/tmp/lume-workspace", "run-1");
    let secondAcquired = false;
    const second = acquireWorkspaceWriterLease("/tmp/lume-workspace", "run-2").then((release) => {
      secondAcquired = true;
      release();
    });
    await Promise.resolve();
    expect(secondAcquired).toBeFalse();
    first();
    await second;
    expect(secondAcquired).toBeTrue();
  });

  test("releases a lease whose owner stops heartbeating", async () => {
    const first = await acquireWorkspaceWriterLease("/tmp/lume-stale-workspace", "run-1", { ttlMs: 20 });
    let secondAcquired = false;
    const second = acquireWorkspaceWriterLease("/tmp/lume-stale-workspace", "run-2", { ttlMs: 20 }).then((release) => {
      secondAcquired = true;
      release();
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await second;
    expect(secondAcquired).toBeTrue();
    first();
  });

  test("heartbeat keeps a long-running lease alive", async () => {
    const first = await acquireWorkspaceWriterLease("/tmp/lume-heartbeat-workspace", "run-1", { ttlMs: 50 });
    let secondAcquired = false;
    const second = acquireWorkspaceWriterLease("/tmp/lume-heartbeat-workspace", "run-2", { ttlMs: 50 }).then((release) => {
      secondAcquired = true;
      release();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    first.heartbeat();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(secondAcquired).toBeFalse();
    first();
    await second;
    expect(secondAcquired).toBeTrue();
  });
});
