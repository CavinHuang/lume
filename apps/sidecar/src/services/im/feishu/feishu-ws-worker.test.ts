import { describe, it, expect } from "bun:test";
import { createFeishuWsWorker, parseFeishuEvent } from "./feishu-ws-worker";
import type { ImRuntimeAccount } from "../im-config-manager";

const makeAccount = (): ImRuntimeAccount =>
  ({
    id: "fs1",
    provider: "feishu",
    accountKey: "appId1",
    token: "sec1",
    label: "飞书",
    enabled: true,
    status: "stopped",
    hasToken: true,
    createdAt: 0,
    updatedAt: 0,
  }) as ImRuntimeAccount;

/** 捕获 start 时传入的 eventDispatcher,从其 handles 取出已注册回调。 */
function makeFakeClient(calls?: string[]): {
  client: { start(p: { eventDispatcher: unknown }): Promise<void>; close(): void };
  getDispatcher: () => { handles: Map<string, (data: unknown) => unknown> } | null;
} {
  let captured: { handles: Map<string, (data: unknown) => unknown> } | null = null;
  const client = {
    start(params: { eventDispatcher: unknown }) {
      calls?.push("start");
      captured = params.eventDispatcher as unknown as { handles: Map<string, (data: unknown) => unknown> };
      return Promise.resolve();
    },
    close() {
      calls?.push("close");
    },
  };
  return { client, getDispatcher: () => captured };
}

describe("createFeishuWsWorker", () => {
  it("start 建 client + 注册回调 + start;回调路由飞书消息;stop close", () => {
    const calls: string[] = [];
    const routes: unknown[] = [];
    const { client, getDispatcher } = makeFakeClient(calls);
    const worker = createFeishuWsWorker({
      account: makeAccount(),
      routeMessage: async (m) => {
        routes.push(m);
      },
      createClient: () => client as never,
    });

    worker.start();
    expect(calls).toEqual(["start"]);
    const handler = getDispatcher()?.handles.get("im.message.receive_v1");
    expect(handler).toBeTruthy();

    handler!({
      message: {
        chat_id: "oc_1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 hi" }),
        message_id: "om_1",
      },
      sender: { sender_id: { open_id: "ou_1" } },
    });
    expect(routes).toHaveLength(1);
    expect((routes[0] as { text: string }).text).toBe("hi"); // 清 @_user_1 占位符
    expect((routes[0] as { peerKind: string }).peerKind).toBe("dm");
    expect((routes[0] as { peerId: string }).peerId).toBe("oc_1");
    expect((routes[0] as { senderId?: string }).senderId).toBe("ou_1");
    expect((routes[0] as { messageId?: string }).messageId).toBe("om_1");
    expect(worker.isRunning()).toBe(true);

    worker.stop();
    expect(calls).toContain("close");
    expect(worker.isRunning()).toBe(false);
  });

  it("非文本消息不路由", () => {
    const routes: unknown[] = [];
    const { client, getDispatcher } = makeFakeClient();
    const worker = createFeishuWsWorker({
      account: makeAccount(),
      routeMessage: async (m) => {
        routes.push(m);
      },
      createClient: () => client as never,
    });
    worker.start();
    const handler = getDispatcher()!.handles.get("im.message.receive_v1")!;
    handler({ message: { chat_id: "oc_1", message_type: "image", content: "{}" } });
    expect(routes).toHaveLength(0);
  });

  it("群聊精确 @ 机器人（open_id 匹配）放行", async () => {
    const routes: unknown[] = [];
    const { client, getDispatcher } = makeFakeClient();
    const worker = createFeishuWsWorker({
      account: makeAccount(),
      routeMessage: async (m) => {
        routes.push(m);
      },
      createClient: () => client as never,
      getBotOpenId: async () => "ou_bot",
      getChatUserCount: async () => 5,
    });
    worker.start();
    const handler = getDispatcher()!.handles.get("im.message.receive_v1")!;
    handler({
      message: {
        chat_id: "oc_g",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 群消息" }),
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Bot" }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(routes).toHaveLength(1);
    expect((routes[0] as { peerKind: string }).peerKind).toBe("group");
  });

  it("群聊 @ 了别人（open_id 不匹配）被拒", async () => {
    const routes: unknown[] = [];
    const { client, getDispatcher } = makeFakeClient();
    const worker = createFeishuWsWorker({
      account: makeAccount(),
      routeMessage: async (m) => {
        routes.push(m);
      },
      createClient: () => client as never,
      getBotOpenId: async () => "ou_bot",
      getChatUserCount: async () => 5,
    });
    worker.start();
    const handler = getDispatcher()!.handles.get("im.message.receive_v1")!;
    handler({
      message: {
        chat_id: "oc_g",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_9 看看这个" }),
        mentions: [{ key: "@_user_9", id: { open_id: "ou_other" }, name: "同事" }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(routes).toHaveLength(0);
  });

  it("单人群免 @ 放行；机器人身份不可得退回 @ 标记启发式", async () => {
    const routes: unknown[] = [];
    const { client, getDispatcher } = makeFakeClient();
    // 身份不可得（null）：单人群仍放行
    let userCount: number | null = 1;
    const worker = createFeishuWsWorker({
      account: makeAccount(),
      routeMessage: async (m) => {
        routes.push(m);
      },
      createClient: () => client as never,
      getBotOpenId: async () => null,
      getChatUserCount: async () => userCount,
    });
    worker.start();
    const handler = getDispatcher()!.handles.get("im.message.receive_v1")!;
    handler({
      message: {
        chat_id: "oc_single",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "不用@也能聊" }),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(routes).toHaveLength(1);

    // 多人群 + 身份不可得 + 无 @ 标记 → 启发式拒绝
    userCount = 5;
    handler({
      message: {
        chat_id: "oc_multi",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "随便说说" }),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(routes).toHaveLength(1);
  });

  it("content 非法 JSON 或仅 @ 占位符时不路由", () => {
    const routes: unknown[] = [];
    const { client, getDispatcher } = makeFakeClient();
    const worker = createFeishuWsWorker({
      account: makeAccount(),
      routeMessage: async (m) => {
        routes.push(m);
      },
      createClient: () => client as never,
    });
    worker.start();
    const handler = getDispatcher()!.handles.get("im.message.receive_v1")!;
    handler({ message: { chat_id: "oc_1", message_type: "text", content: "{bad json" } });
    handler({ message: { chat_id: "oc_1", message_type: "text", content: JSON.stringify({ text: "@_user_1   @_user_2" }) } });
    expect(routes).toHaveLength(0);
  });

  it("缺少凭据时不启动且标记 auth_required", () => {
    const updated: Array<{ id: string; status?: string }> = [];
    const worker = createFeishuWsWorker({
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

  it("停止后忽略旧连接的异步失败，不覆盖 stopped 状态", async () => {
    let rejectStart!: (error: Error) => void;
    const statuses: string[] = [];
    const pending = new Promise<void>((_, reject) => { rejectStart = reject; });
    const { client } = makeFakeClient();
    client.start = () => pending;
    const worker = createFeishuWsWorker({
      account: makeAccount(),
      updateAccount: async (_id, input) => {
        if (input.status) statuses.push(input.status);
      },
      createClient: () => client as never,
    });

    worker.start();
    worker.stop();
    rejectStart(new Error("late start failure"));
    await Promise.resolve();

    expect(statuses).toEqual([]);
    expect(worker.isRunning()).toBe(false);
  });
});

describe("parseFeishuEvent", () => {
  it("清理 @_user_N 占位符并折叠空白", () => {
    const msg = parseFeishuEvent(
      {
        message: {
          chat_id: "oc",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "@_user_1 你好 @_user_2" }),
        },
      },
      makeAccount(),
    );
    expect(msg?.text).toBe("你好");
  });

  it("无 message 或无文本返回 null", () => {
    expect(parseFeishuEvent({}, makeAccount())).toBeNull();
    expect(parseFeishuEvent(null, makeAccount())).toBeNull();
    expect(
      parseFeishuEvent({ message: { chat_id: "oc", message_type: "text", content: JSON.stringify({ text: "" }) } }, makeAccount()),
    ).toBeNull();
  });
});
