import { describe, it, expect } from "bun:test";
import { createDingtalkStreamWorker, parseDingtalkEvent } from "./dingtalk-stream-worker";
import type { ImRuntimeAccount } from "../im-config-manager";

const makeAccount = (): ImRuntimeAccount =>
  ({
    id: "dt1",
    provider: "dingtalk",
    accountKey: "cid",
    token: "csec",
    label: "钉钉",
    enabled: true,
    status: "stopped",
    hasToken: true,
    createdAt: 0,
    updatedAt: 0,
  }) as ImRuntimeAccount;

interface FakeClient {
  registerAllEventListener: (fn: (e: unknown) => unknown) => void;
  connect: () => Promise<void>;
  disconnect: () => void;
}

function makeFakeClient(calls?: string[]): { client: FakeClient; handler: () => ((e: unknown) => unknown) | null } {
  let handler: ((e: unknown) => unknown) | null = null;
  const client: FakeClient = {
    registerAllEventListener(fn) {
      calls?.push("register");
      handler = fn;
    },
    connect() {
      calls?.push("connect");
      return Promise.resolve();
    },
    disconnect() {
      calls?.push("disconnect");
    },
  };
  return { client, handler: () => handler };
}

describe("createDingtalkStreamWorker", () => {
  it("start 建 client + 注册监听 + connect;回调路由 dingtalk 消息;stop disconnect", () => {
    const calls: string[] = [];
    const routes: unknown[] = [];
    const { client, handler } = makeFakeClient(calls);

    const worker = createDingtalkStreamWorker({
      account: makeAccount(),
      routeMessage: async (m) => {
        routes.push(m);
      },
      createClient: () => client as never,
    });

    worker.start();
    expect(calls).toEqual(["register", "connect"]);
    expect(handler()).not.toBeNull();

    // 触发事件(data 为 object,parseDingtalkEvent 兼容 string|object)
    const result = handler()!({
      data: { conversationId: "c1", conversationType: "2", text: { content: " hi " }, senderStaffId: "s1", sessionWebhook: "https://hw", msgId: "m1", conversationName: "群A" },
    });
    expect(result).toEqual({ status: "SUCCESS" });
    expect(routes).toHaveLength(1);
    expect((routes[0] as { provider: string }).provider).toBe("dingtalk");
    expect((routes[0] as { text: string }).text).toBe("hi"); // 去 @前缀 + trim
    expect((routes[0] as { contextToken?: string }).contextToken).toBe("https://hw");
    expect((routes[0] as { peerKind: string }).peerKind).toBe("group");
    expect(worker.isRunning()).toBe(true);

    worker.stop();
    expect(calls).toContain("disconnect");
    expect(worker.isRunning()).toBe(false);
  });

  it("event 非文本消息时返回 SUCCESS 不路由", () => {
    const routes: unknown[] = [];
    const { client, handler } = makeFakeClient();
    const worker = createDingtalkStreamWorker({
      account: makeAccount(),
      routeMessage: async (m) => {
        routes.push(m);
      },
      createClient: () => client as never,
    });
    worker.start();
    const result = handler()!({ data: { /* 无 text */ } });
    expect(routes).toHaveLength(0);
    expect(result).toEqual({ status: "SUCCESS" });
    worker.stop();
  });

  it("data 为 JSON 字符串(真实 SDK 形态)时正确解析", () => {
    const routes: unknown[] = [];
    const { client, handler } = makeFakeClient();
    const worker = createDingtalkStreamWorker({
      account: makeAccount(),
      routeMessage: async (m) => {
        routes.push(m);
      },
      createClient: () => client as never,
    });
    worker.start();
    handler()!({
      data: JSON.stringify({
        conversationId: "c2",
        conversationType: "1",
        text: { content: "hello" },
        senderStaffId: "s2",
        sessionWebhook: "https://hw2",
        msgId: "m2",
        senderNick: "张三",
      }),
    });
    expect(routes).toHaveLength(1);
    expect((routes[0] as { text: string }).text).toBe("hello");
    expect((routes[0] as { peerKind: string }).peerKind).toBe("dm");
    expect((routes[0] as { peerName?: string }).peerName).toBe("张三"); // conversationName 缺失回退 senderNick
    worker.stop();
  });

  it("缺少凭据时不启动且标记 auth_required", () => {
    const updated: { id: string; status?: string }[] = [];
    const worker = createDingtalkStreamWorker({
      account: { ...makeAccount(), accountKey: undefined, token: "" } as ImRuntimeAccount,
      updateAccount: async (id, input) => {
        updated.push({ id, ...input });
      },
      createClient: () => {
        throw new Error("should not create client");
      },
    });
    worker.start();
    expect(worker.isRunning()).toBe(false);
    expect(updated).toHaveLength(1);
    expect(updated[0]?.status).toBe("auth_required");
  });
});

describe("parseDingtalkEvent", () => {
  it("清理 @机器人 前缀", () => {
    const msg = parseDingtalkEvent(
      { data: { conversationId: "c", conversationType: "1", text: { content: "@机器人 你好" }, senderStaffId: "s", sessionWebhook: "hw", msgId: "m" } },
      makeAccount(),
    );
    expect(msg?.text).toBe("你好");
  });

  it("无文本返回 null", () => {
    expect(parseDingtalkEvent({ data: { conversationId: "c" } }, makeAccount())).toBeNull();
    expect(parseDingtalkEvent({ data: JSON.stringify({ conversationType: "1" }) }, makeAccount())).toBeNull();
  });
});
