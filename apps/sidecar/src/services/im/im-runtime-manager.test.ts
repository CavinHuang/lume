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
});
