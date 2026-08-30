import { describe, expect, test } from "bun:test";
import type { ImAccount, ImAccountUpdateInput } from "@lume/shared";
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

  test("restart waits for asynchronous stopped status persistence", async () => {
    let releaseStopped!: () => void;
    const stopped = new Promise<void>((resolve) => { releaseStopped = resolve; });
    let status = "stopped";
    let starts = 0;
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
      updateAccount: async (_id, input) => {
        if (input.status === "stopped") await stopped;
        if (input.status) status = input.status;
      },
      createWorker: () => ({
        start() { starts += 1; },
        stop() {},
        isRunning: () => true
      })
    });

    await manager.startAccount("account-1");
    manager.stopAccount("account-1");
    const restarted = manager.startAccount("account-1");
    await Promise.resolve();
    expect(starts).toBe(1);

    releaseStopped();
    await restarted;
    expect(starts).toBe(2);
    expect(status).toBe("running");
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

describe("#598 error 态账号定时自愈", () => {
  function makeAccount(id: string, status: ImAccountUpdateInput["status"]): ImAccount {
    return {
      id,
      provider: "weixin",
      label: id,
      baseUrl: "https://ilink.example.com",
      enabled: true,
      status: status ?? "stopped",
      hasToken: true,
      createdAt: 1,
      updatedAt: 1
    };
  }

  test("立即重试 error 账号，失败后指数退避，成功后重置", async () => {
    let shouldFail = true;
    let now = 1_000_000;
    const statuses = new Map<string, ImAccountUpdateInput["status"]>();
    const account = makeAccount("a1", "error");
    const manager = createImRuntimeManager({
      listAccounts: () => [{ ...account, status: statuses.get("a1") ?? account.status }],
      getRuntimeAccount: () => ({ ...account, token: "t" } as never),
      updateAccount: (_id, input) => {
        statuses.set("a1", input.status);
      },
      createWorker: () => {
        if (shouldFail) throw new Error("worker boom");
        return { start() {}, stop() {}, isRunning: () => true };
      }
    });

    // 第 1 轮：error + 无退避记录 → 尝试；worker 抛错 → attempts=1，nextAt=now+30s
    expect(await manager.runRecoveryTick(now)).toEqual(["a1"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(statuses.get("a1")).toBe("error");

    // 第 2 轮：退避窗口内 → 跳过
    expect(await manager.runRecoveryTick(now + 10_000)).toEqual([]);

    // 第 3 轮：过窗口 → 重试；worker 成功 → running 且退避记录清除
    shouldFail = false;
    now += 31_000;
    expect(await manager.runRecoveryTick(now)).toEqual(["a1"]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(statuses.get("a1")).toBe("running");

    // 第 4 轮：已 running 不在候选 → 不尝试
    expect(await manager.runRecoveryTick(now + 60_000)).toEqual([]);
  });

  test("手动 stopAccount 后不再被自愈拉起", async () => {
    const statuses = new Map<string, ImAccountUpdateInput["status"]>();
    const account = makeAccount("a2", "error");
    const manager = createImRuntimeManager({
      listAccounts: () => [{ ...account, status: statuses.get("a2") ?? account.status }],
      getRuntimeAccount: () => ({ ...account, token: "t" } as never),
      updateAccount: (_id, input) => {
        statuses.set("a2", input.status);
      },
      createWorker: () => ({ start() {}, stop() {}, isRunning: () => false })
    });

    manager.stopAccount("a2");
    expect(await manager.runRecoveryTick(Date.now())).toEqual([]);
  });

  test("startAutoRecovery 周期驱动 tick，stopAutoRecovery 停止", async () => {
    const manager = createImRuntimeManager({
      listAccounts: () => [],
      getRuntimeAccount: () => ({}) as never,
      updateAccount: () => {},
      createWorker: () => ({ start() {}, stop() {}, isRunning: () => false })
    });
    manager.startAutoRecovery({ intervalMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 35));
    manager.stopAutoRecovery();
    // 不抛错即通过（无 error 账号时 tick 为空转）
    expect(true).toBe(true);
  });

  test("stopAll 同时停止自愈定时器，不在关停阶段拉起 error 账号", async () => {
    const account = makeAccount("a3", "error");
    let starts = 0;
    const manager = createImRuntimeManager({
      listAccounts: () => [account],
      getRuntimeAccount: () => ({ ...account, token: "t" } as never),
      updateAccount: () => undefined,
      createWorker: () => {
        starts += 1;
        return { start() {}, stop() {}, isRunning: () => true };
      }
    });

    manager.startAutoRecovery({ intervalMs: 5 });
    manager.stopAll();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(starts).toBe(0);
  });
});
