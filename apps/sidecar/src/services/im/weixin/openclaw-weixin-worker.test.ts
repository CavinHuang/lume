import { describe, expect, test } from "bun:test";
import { createOpenClawWeixinWorker } from "./openclaw-weixin-worker";

describe("openclaw-weixin-worker", () => {
  test("routes updates and saves latest cursor and context", async () => {
    const routed: unknown[] = [];
    const updates: unknown[] = [];
    const worker = createOpenClawWeixinWorker({
      account: {
        id: "account-1",
        provider: "weixin",
        label: "工作微信",
        token: "token-1",
        baseUrl: "https://ilink.example.com",
        enabled: true,
        status: "running",
        hasToken: true,
        cursor: "cursor-1",
        createdAt: 1,
        updatedAt: 1
      },
      api: {
        getUpdates: async () => ({
          cursor: "cursor-2",
          updates: [{
            peerId: "user-1",
            peerKind: "dm",
            peerName: "Alice",
            text: "hello",
            contextToken: "ctx-1"
          }]
        }),
        sendText: async () => ({ ok: true }),
        notifyStart: async () => ({ ok: true }),
        notifyStop: async () => ({ ok: true })
      },
      routeMessage: async (message) => {
        routed.push(message);
      },
      updateAccount: async (_id, input) => {
        updates.push(input);
      }
    });

    await worker.processOnce();

    expect(routed).toEqual([expect.objectContaining({
      provider: "weixin",
      accountId: "account-1",
      accountLabel: "工作微信",
      peerId: "user-1",
      text: "hello",
      contextToken: "ctx-1"
    })]);
    expect(updates).toContainEqual(expect.objectContaining({
      cursor: "cursor-2",
      contextToken: "ctx-1",
      status: "running"
    }));
  });

  test("notifies lifecycle start and stop", async () => {
    const calls: string[] = [];
    const worker = createOpenClawWeixinWorker({
      account: {
        id: "account-1",
        provider: "weixin",
        label: "工作微信",
        token: "token-1",
        baseUrl: "https://ilink.example.com",
        enabled: true,
        status: "running",
        hasToken: true,
        createdAt: 1,
        updatedAt: 1
      },
      pollIntervalMs: 60_000,
      api: {
        getUpdates: async () => ({ updates: [] }),
        sendText: async () => ({ ok: true }),
        notifyStart: async () => { calls.push("start") },
        notifyStop: async () => { calls.push("stop") }
      }
    });

    worker.start();
    await Promise.resolve();
    worker.stop();
    await Promise.resolve();

    expect(calls).toEqual(["start", "stop"]);
  });
});
