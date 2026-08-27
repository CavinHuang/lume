import { describe, expect, test } from "bun:test";
import type { ImAccountUpdateInput } from "@lume/shared";
import { createImRuntimeManager } from "./im-runtime-manager";

describe("im-runtime-manager", () => {
  test("starts one worker per enabled account and isolates account failures", async () => {
    const started: string[] = [];
    const updated: Array<{ id: string; input: ImAccountUpdateInput }> = [];
    const manager = createImRuntimeManager({
      listAccounts: () => [
        {
          id: "account-ok",
          provider: "weixin",
          label: "工作微信",
          baseUrl: "https://ilink.example.com",
          enabled: true,
          status: "stopped",
          hasToken: true,
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: "account-disabled",
          provider: "weixin",
          label: "禁用微信",
          baseUrl: "https://ilink.example.com",
          enabled: false,
          status: "stopped",
          hasToken: true,
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: "account-bad",
          provider: "weixin",
          label: "异常微信",
          baseUrl: "https://ilink.example.com",
          enabled: true,
          status: "stopped",
          hasToken: true,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      getRuntimeAccount: (id) => ({
        id,
        provider: "weixin",
        label: id,
        token: `token-${id}`,
        baseUrl: "https://ilink.example.com",
        enabled: true,
        status: "stopped",
        hasToken: true,
        createdAt: 1,
        updatedAt: 1
      }),
      updateAccount: (id, input) => {
        updated.push({ id, input });
      },
      createWorker: (account) => ({
        start() {
          started.push(account.id);
          if (account.id === "account-bad") {
            throw new Error("login failed");
          }
        },
        stop() {},
        isRunning: () => true
      })
    });

    await manager.startEnabledAccounts();

    expect(started).toEqual(["account-ok", "account-bad"]);
    expect(manager.getRunningAccountIds()).toEqual(["account-ok"]);
    expect(updated).toContainEqual({
      id: "account-bad",
      input: expect.objectContaining({
        status: "error",
        lastError: "login failed"
      })
    });
  });

  test("replaces a stale stopped worker when starting the same account again", async () => {
    const started: string[] = [];
    let workerIndex = 0;
    const manager = createImRuntimeManager({
      getRuntimeAccount: (id) => ({
        id,
        provider: "weixin",
        label: id,
        token: `token-${id}`,
        baseUrl: "https://ilink.example.com",
        enabled: true,
        status: "stopped",
        hasToken: true,
        createdAt: 1,
        updatedAt: 1
      }),
      updateAccount: () => undefined,
      createWorker: () => {
        workerIndex += 1;
        const workerId = workerIndex;
        let running = true;
        return {
          start() {
            started.push(`worker-${workerId}`);
            running = false;
          },
          stop() {},
          isRunning: () => running
        };
      }
    });

    await manager.startAccount("account-1");
    await manager.startAccount("account-1");

    expect(started).toEqual(["worker-1", "worker-2"]);
  });

  test("coalesces concurrent starts for the same account", async () => {
    let releaseStarting!: () => void;
    const starting = new Promise<void>((resolve) => { releaseStarting = resolve; });
    const started: string[] = [];
    const manager = createImRuntimeManager({
      getRuntimeAccount: (id) => ({
        id,
        provider: "weixin",
        label: id,
        token: `token-${id}`,
        baseUrl: "https://ilink.example.com",
        enabled: true,
        status: "stopped",
        hasToken: true,
        createdAt: 1,
        updatedAt: 1
      }),
      updateAccount: (_id, input) => input.status === "starting" ? starting : undefined,
      createWorker: (account) => ({
        start() { started.push(account.id); },
        stop() {},
        isRunning: () => true
      })
    });

    const first = manager.startAccount("account-1");
    const second = manager.startAccount("account-1");
    releaseStarting();
    await Promise.all([first, second]);

    expect(started).toEqual(["account-1"]);
  });

  test("stop cancels an account while its start is pending", async () => {
    let releaseStarting!: () => void;
    let reachedStarting!: () => void;
    const starting = new Promise<void>((resolve) => { releaseStarting = resolve; });
    const reached = new Promise<void>((resolve) => { reachedStarting = resolve; });
    const statuses: string[] = [];
    const started: string[] = [];
    const manager = createImRuntimeManager({
      getRuntimeAccount: (id) => ({
        id,
        provider: "weixin",
        label: id,
        token: `token-${id}`,
        baseUrl: "https://ilink.example.com",
        enabled: true,
        status: "stopped",
        hasToken: true,
        createdAt: 1,
        updatedAt: 1
      }),
      updateAccount: (_id, input) => {
        if (input.status) statuses.push(input.status);
        if (input.status === "starting") {
          reachedStarting();
          return starting;
        }
      },
      createWorker: (account) => ({
        start() { started.push(account.id); },
        stop() {},
        isRunning: () => true
      })
    });

    const start = manager.startAccount("account-1");
    await reached;
    manager.stopAccount("account-1");
    releaseStarting();
    await start;

    expect(started).toEqual([]);
    expect(manager.getRunningAccountIds()).toEqual([]);
    expect(statuses.at(-1)).toBe("stopped");
  });

  test("a new start after stop does not reuse the cancelled pending start", async () => {
    let releaseFirstStart!: () => void;
    let reachedFirstStart!: () => void;
    const firstStarting = new Promise<void>((resolve) => { releaseFirstStart = resolve; });
    const reached = new Promise<void>((resolve) => { reachedFirstStart = resolve; });
    let startingUpdates = 0;
    const started: string[] = [];
    const manager = createImRuntimeManager({
      getRuntimeAccount: (id) => ({
        id,
        provider: "weixin",
        label: id,
        token: `token-${id}`,
        baseUrl: "https://ilink.example.com",
        enabled: true,
        status: "stopped",
        hasToken: true,
        createdAt: 1,
        updatedAt: 1
      }),
      updateAccount: (_id, input) => {
        if (input.status !== "starting") return;
        startingUpdates += 1;
        if (startingUpdates === 1) {
          reachedFirstStart();
          return firstStarting;
        }
      },
      createWorker: (account) => ({
        start() { started.push(account.id); },
        stop() {},
        isRunning: () => true
      })
    });

    const cancelledStart = manager.startAccount("account-1");
    await reached;
    manager.stopAccount("account-1");
    const restarted = manager.startAccount("account-1");
    releaseFirstStart();
    await Promise.all([cancelledStart, restarted]);

    expect(startingUpdates).toBe(2);
    expect(started).toEqual(["account-1"]);
    expect(manager.getRunningAccountIds()).toEqual(["account-1"]);
  });

  test("cleans up a started worker when running status persistence fails", async () => {
    let stopped = 0;
    const manager = createImRuntimeManager({
      getRuntimeAccount: (id) => ({
        id,
        provider: "weixin",
        label: id,
        token: `token-${id}`,
        baseUrl: "https://ilink.example.com",
        enabled: true,
        status: "stopped",
        hasToken: true,
        createdAt: 1,
        updatedAt: 1
      }),
      updateAccount: (_id, input) => {
        if (input.status === "running") throw new Error("write failed");
      },
      createWorker: () => ({
        start() {},
        stop() { stopped += 1; },
        isRunning: () => true
      })
    });

    await expect(manager.startAccount("account-1")).rejects.toThrow("write failed");

    expect(stopped).toBe(1);
    expect(manager.getRunningAccountIds()).toEqual([]);
  });
});
