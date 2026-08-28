import { describe, it, expect, beforeEach } from "bun:test";
import { createWecomWsWorker, parseWecomEvent } from "./wecom-ws-worker";
import { getWecomClient, __clearWecomClientPoolForTests } from "./wecom-client-pool";
import type { ImRuntimeAccount } from "../im-config-manager";

const makeAccount = (id = "wc1"): ImRuntimeAccount =>
  ({
    id,
    provider: "wecom",
    accountKey: "bot1",
    token: "sec1",
    label: "企业微信",
    enabled: true,
    status: "stopped",
    hasToken: true,
    createdAt: 0,
    updatedAt: 0,
  }) as ImRuntimeAccount;

function makeFakeClient(calls?: string[]): {
  client: { connect(): void; disconnect(): void; on(event: string, cb: (data: unknown) => void): void };
  getHandler: (event?: string) => ((data: unknown) => void) | null;
} {
  const handlers = new Map<string, (data: unknown) => void>();
  const client = {
    connect() {
      calls?.push("connect");
    },
    disconnect() {
      calls?.push("disconnect");
    },
    on(event: string, cb: (data: unknown) => void) {
      calls?.push(`on:${event}`);
      handlers.set(event, cb);
    },
  };
  return { client, getHandler: (event = "message.text") => handlers.get(event) ?? null };
}

beforeEach(() => {
  __clearWecomClientPoolForTests();
});

describe("createWecomWsWorker", () => {
  it("start 注册连接池 + connect + 注册回调;回调路由企微消息;stop 注销池 + disconnect", () => {
    const calls: string[] = [];
    const routes: unknown[] = [];
    const account = makeAccount();
    const { client, getHandler } = makeFakeClient(calls);
    const worker = createWecomWsWorker({
      account,
      routeMessage: async (m) => {
        routes.push(m);
      },
      createClient: () => client as never,
    });

    worker.start();
    // 断线/error/恢复监听必须注册：SDK 重连放弃后 eventemitter3 对无监听 error
    // 静默——缺监听会让账号永久假活
    expect(calls).toEqual([
      "on:message.text", "on:error", "on:disconnected", "on:connected", "on:authenticated", "connect",
    ]);
    expect(getWecomClient(account.id)).toBe(client as never); // 启动即入池
    const handler = getHandler();
    expect(handler).not.toBeNull();

    handler!({
      headers: { req_id: "r1" },
      body: { chatid: "g1", chattype: "group", from: { userid: "u1" }, text: { content: "@bot 你好" }, msgtype: "text" },
    });
    expect(routes).toHaveLength(1);
    expect((routes[0] as { text: string }).text).toBe("你好"); // 清 @bot 前缀
    expect((routes[0] as { peerKind: string }).peerKind).toBe("group");
    expect((routes[0] as { peerId: string }).peerId).toBe("g1");
    expect((routes[0] as { senderId?: string }).senderId).toBe("u1");
    expect((routes[0] as { messageId?: string }).messageId).toBe("r1");
    expect(worker.isRunning()).toBe(true);

    worker.stop();
    expect(calls).toContain("disconnect");
    expect(getWecomClient(account.id)).toBeUndefined(); // 停止即出池
    expect(worker.isRunning()).toBe(false);
  });

  it("单聊无 chatid → peerId 回退 userid", () => {
    const routes: unknown[] = [];
    const { client, getHandler } = makeFakeClient();
    const worker = createWecomWsWorker({
      account: makeAccount(),
      routeMessage: async (m) => {
        routes.push(m);
      },
      createClient: () => client as never,
    });
    worker.start();
    getHandler()!({
      headers: { req_id: "r2" },
      body: { chattype: "single", from: { userid: "u2" }, text: { content: "私聊" }, msgtype: "text" },
    });
    expect((routes[0] as { peerKind: string }).peerKind).toBe("dm");
    expect((routes[0] as { peerId: string }).peerId).toBe("u2");
  });

  it("无文本内容不路由", () => {
    const routes: unknown[] = [];
    const { client, getHandler } = makeFakeClient();
    const worker = createWecomWsWorker({
      account: makeAccount(),
      routeMessage: async (m) => {
        routes.push(m);
      },
      createClient: () => client as never,
    });
    worker.start();
    getHandler()!({ headers: { req_id: "r3" }, body: { chattype: "single", from: { userid: "u" }, text: { content: "  " } } });
    getHandler()!({ headers: { req_id: "r4" } }); // 无 body
    expect(routes).toHaveLength(0);
  });

  it("缺少凭据时不启动且标记 auth_required,不入池", () => {
    const updated: Array<{ id: string; status?: string }> = [];
    const account = makeAccount("wc-nocred");
    const worker = createWecomWsWorker({
      account: { ...account, accountKey: undefined, token: "" } as ImRuntimeAccount,
      updateAccount: async (id, input) => {
        updated.push({ id, ...input });
      },
      createClient: () => {
        throw new Error("should not create client");
      },
    });
    worker.start();
    expect(worker.isRunning()).toBe(false);
    expect(getWecomClient(account.id)).toBeUndefined();
    expect(updated).toHaveLength(1);
    expect(updated[0]?.status).toBe("auth_required");
  });
});

describe("parseWecomEvent", () => {
  it("清理 @ 机器人前缀", () => {
    const msg = parseWecomEvent(
      { headers: { req_id: "r" }, body: { chatid: "g", chattype: "group", from: { userid: "u" }, text: { content: "@机器人 hi" } } },
      makeAccount(),
    );
    expect(msg?.text).toBe("hi");
  });

  it("#598 群聊内嵌 @（如邮箱 a@b.com）不触发门控，词首 @ 仍放行", () => {
    const build = (content: string) => ({ headers: { req_id: "r" }, body: { chatid: "g", chattype: "group", from: { userid: "u" }, text: { content } } });
    expect(parseWecomEvent(build("联系我 a@b.com"), makeAccount())).toBeNull();
    // @ 在文本中间但前面是空白 → 仍是 at 形态，放行
    expect(parseWecomEvent(build("hi @bot 在吗"), makeAccount())?.text).toBe("hi @bot 在吗");
  });

  it("无 body 或无文本返回 null", () => {
    expect(parseWecomEvent({}, makeAccount())).toBeNull();
    expect(parseWecomEvent(null, makeAccount())).toBeNull();
    expect(parseWecomEvent({ body: { chattype: "single", from: { userid: "u" }, text: { content: "" } } }, makeAccount())).toBeNull();
  });
});

describe("createWecomWsWorker 断线宽限", () => {
  it("瞬断在宽限窗口内恢复：不判死、连接池保留", async () => {
    const statusWrites: Array<Record<string, unknown>> = [];
    const { client, getHandler } = makeFakeClient();
    let handlers: Record<string, (data: unknown) => void> = {};
    const wrapped = {
      connect: client.connect,
      disconnect: client.disconnect,
      on: (event: string, cb: (data: unknown) => void) => {
        handlers[event] = cb;
      },
    };
    const worker = createWecomWsWorker({
      account: makeAccount(),
      routeMessage: async () => undefined,
      createClient: () => wrapped as never,
      updateAccount: (id, input) => {
        statusWrites.push({ id, ...input });
      },
      disconnectGraceMs: 5_000,
    });
    worker.start();
    handlers["disconnected"]?.(undefined);
    expect(worker.isRunning()).toBe(true);
    expect(getWecomClient(makeAccount().id)).not.toBeUndefined();
    // SDK 自愈重连成功
    handlers["connected"]?.(undefined);
    expect(statusWrites).toEqual([]);
  });

  it("宽限窗口超时未恢复：判死转 error 态并出池", async () => {
    const statusWrites: Array<Record<string, unknown>> = [];
    const { client, getHandler } = makeFakeClient();
    void getHandler;
    const handlers: Record<string, (data: unknown) => void> = {};
    const worker = createWecomWsWorker({
      account: makeAccount(),
      routeMessage: async () => undefined,
      createClient: () => ({
        connect: client.connect,
        disconnect: client.disconnect,
        on: (event: string, cb: (data: unknown) => void) => {
          handlers[event] = cb;
        },
      }) as never,
      updateAccount: (id, input) => {
        statusWrites.push({ id, ...input });
      },
      disconnectGraceMs: 10,
    });
    worker.start();
    handlers["error"]?.(new Error("kicked"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(worker.isRunning()).toBe(false);
    expect(getWecomClient(makeAccount().id)).toBeUndefined();
    expect(statusWrites.at(-1)).toMatchObject({ status: "error" });
  });

  it("stop 后旧 client 迟到的断开事件不影响新会话（跨代隔离）", async () => {
    const statusWrites: Array<Record<string, unknown>> = [];
    let currentHandlers: Record<string, (data: unknown) => void> = {};
    const makeWrapped = () => ({
      connect: () => undefined,
      disconnect: () => undefined,
      on: (event: string, cb: (data: unknown) => void) => {
        currentHandlers[event] = cb;
      },
    });
    const worker = createWecomWsWorker({
      account: makeAccount(),
      routeMessage: async () => undefined,
      createClient: () => makeWrapped() as never,
      updateAccount: (id, input) => {
        statusWrites.push({ id, ...input });
      },
      disconnectGraceMs: 10,
    });
    worker.start();
    const oldHandlers = currentHandlers;
    // 第二个会话使用全新的 handlers 表（模拟 manager 重建的新 client）
    currentHandlers = {};
    worker.stop();
    worker.start();
    oldHandlers["disconnected"]?.(undefined);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(worker.isRunning()).toBe(true);
    expect(statusWrites).toEqual([]);
  });
});

describe("parseWecomEvent #544 镜像群免 @", () => {
  const groupFrame = {
    headers: { req_id: "r1" },
    body: { chatid: "gid", chattype: "group", from: { userid: "u1" }, text: { content: "普通群聊" } },
  };

  it("镜像谓词命中：群聊消息免 @ 放行", () => {
    const msg = parseWecomEvent(groupFrame, makeAccount(), () => true);
    expect(msg?.peerKind).toBe("group");
    expect(msg?.peerId).toBe("gid");
  });

  it("恒假谓词仍按门控丢弃", () => {
    expect(parseWecomEvent(groupFrame, makeAccount(), () => false)).toBeNull();
  });

  it("默认不传谓词行为不变（回归钉死）", () => {
    expect(parseWecomEvent(groupFrame, makeAccount())).toBeNull();
  });
});
