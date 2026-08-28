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

    // 触发事件(data 为 object,parseDingtalkEvent 兼容 string|object)；群聊须带 @ 门控（#405）
    const result = handler()!({
      data: { conversationId: "c1", conversationType: "2", text: { content: "@机器人 hi" }, senderStaffId: "s1", sessionWebhook: "https://hw", msgId: "m1", conversationName: "群A" },
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

  it("#598 senderName 取 senderNick（群聊前缀显示名来源）", () => {
    const msg = parseDingtalkEvent(
      { data: { conversationId: "c", conversationType: "2", text: { content: "帮忙看下" }, senderNick: "李四", senderStaffId: "s", sessionWebhook: "hw", msgId: "m", atUsers: [{ dingtalkId: "x" }] } },
      makeAccount(),
    );
    expect(msg?.senderName).toBe("李四");
  });

  it("群聊无 @ 门控直接忽略（#405）", () => {
    expect(
      parseDingtalkEvent(
        { data: { conversationId: "c", conversationType: "2", text: { content: "普通群聊" }, senderStaffId: "s", sessionWebhook: "hw", msgId: "m" } },
        makeAccount(),
      ),
    ).toBeNull();
  });

  it("#598 群聊内嵌 @（如邮箱 a@b.com）不触发门控", () => {
    expect(
      parseDingtalkEvent(
        { data: { conversationId: "c", conversationType: "2", text: { content: "联系我 a@b.com" }, senderStaffId: "s", sessionWebhook: "hw", msgId: "m" } },
        makeAccount(),
      ),
    ).toBeNull();
  });

  it("#598 atUsers 结构化字段优先：为空即使文本含 @ 也忽略，非空则放行", () => {
    // 平台确认未 at 任何人（atUsers 空数组）→ 文本里的 a@b.com 不触发
    expect(
      parseDingtalkEvent(
        { data: { conversationId: "c", conversationType: "2", text: { content: "联系我 a@b.com" }, atUsers: [], senderStaffId: "s", sessionWebhook: "hw", msgId: "m" } },
        makeAccount(),
      ),
    ).toBeNull();
    // 真实 at → 放行（文本无需再含 @ 字面量）
    const msg = parseDingtalkEvent(
      { data: { conversationId: "c", conversationType: "2", text: { content: "帮忙看下" }, atUsers: [{ dingtalkId: "x" }], senderStaffId: "s", sessionWebhook: "hw", msgId: "m" } },
      makeAccount(),
    );
    expect(msg?.text).toBe("帮忙看下");
  });

  it("无文本返回 null", () => {
    expect(parseDingtalkEvent({ data: { conversationId: "c" } }, makeAccount())).toBeNull();
    expect(parseDingtalkEvent({ data: JSON.stringify({ conversationType: "1" }) }, makeAccount())).toBeNull();
  });
});
