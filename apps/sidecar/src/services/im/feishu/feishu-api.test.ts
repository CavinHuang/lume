import { describe, it, expect } from "bun:test";
import {
  sendFeishuText,
  createFeishuGroupChat,
  updateFeishuChatName,
  leaveFeishuChat,
  resetFeishuBotOpenIdCacheForTest,
  type FeishuRestClient,
} from "./feishu-api";

/** 新增镜像群端点的行为旋钮；省略字段一律成功路径。 */
interface MirrorFakeBehavior {
  createChat?: { code: number; msg?: string; chatId?: string };
  updateChat?: { code: number; msg?: string };
  deleteMembers?: { code: number; msg?: string };
  botThrows?: boolean;
}

function makeFakeClient(captured: unknown[], behavior: MirrorFakeBehavior = {}): FeishuRestClient {
  return {
    im: {
      v1: {
        message: {
          create: async (req) => {
            captured.push(req);
          },
          get: async () => ({ code: 0 }),
        },
        chat: {
          get: async () => ({ code: 0 }),
          // 镜像端点捕获包一层 {kind} 便于按端点断言；message 保持裸形状兼容旧断言
          create: async (req) => {
            captured.push({ kind: "chat.create", req });
            const b = behavior.createChat;
            if (b && (b.code ?? 0) !== 0) return { code: b.code, msg: b.msg };
            return { code: 0, data: { chat_id: b?.chatId ?? "oc_new_group" } };
          },
          update: async (req) => {
            captured.push({ kind: "chat.update", req });
            const b = behavior.updateChat;
            if (b && (b.code ?? 0) !== 0) return { code: b.code, msg: b.msg };
            return { code: 0 };
          },
        },
        chatMembers: {
          create: async () => ({ code: 0 }),
          delete: async (req) => {
            captured.push({ kind: "members.delete", req });
            const b = behavior.deleteMembers;
            if (b && (b.code ?? 0) !== 0) return { code: b.code, msg: b.msg };
            return { code: 0 };
          },
        },
      },
    },
    bot: {
      v3: {
        botInfo: {
          get: async () => {
            if (behavior.botThrows) throw new Error("down");
            return { code: 0, bot: { open_id: "ou_bot" } };
          },
        },
      },
    },
    cardkit: {
      v1: {
        card: {
          create: async () => ({ code: 0, data: { card_id: "card_fake" } }),
          update: async () => ({ code: 0 }),
        },
      },
    },
  };
}

function captureOf(captured: unknown[], kind: string): unknown {
  return captured.find((item) => (item as { kind?: string }).kind === kind);
}

describe("sendFeishuText", () => {
  it("调 client.im.v1.message.create 发文本(receive_id=chat_id)", async () => {
    const calls: unknown[] = [];
    const res = await sendFeishuText(
      { appId: "cli_x", appSecret: "sec", peerId: "oc_chat1", text: "hello" },
      { createClient: () => makeFakeClient(calls) },
    );
    expect(res.ok).toBe(true);
    const req = calls[0] as {
      params: { receive_id_type: string };
      data: { receive_id: string; msg_type: string; content: string };
    };
    expect(req.params).toEqual({ receive_id_type: "chat_id" });
    expect(req.data.msg_type).toBe("text");
    expect(req.data.receive_id).toBe("oc_chat1");
    expect(JSON.parse(req.data.content)).toEqual({ text: "hello" });
  });

  it("缺凭据返回 ok:false", async () => {
    const res = await sendFeishuText({ appId: "", appSecret: "", peerId: "c", text: "x" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("App ID");
  });

  it("create 抛错时返回 ok:false 含错误信息", async () => {
    const captured: unknown[] = [];
    const fake = makeFakeClient(captured);
    const res = await sendFeishuText(
      { appId: "a", appSecret: "s", peerId: "c", text: "x" },
      {
        createClient: () => ({
          ...fake,
          im: {
            v1: {
              ...fake.im.v1,
              message: {
                ...fake.im.v1.message,
                create: async () => Promise.reject(new Error("boom")),
              },
            },
          },
        }),
      },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("boom");
  });
});

describe("入站增强读取面", () => {
  it("getFeishuBotOpenId 缓存后不再请求；失败返回 null", async () => {
    const { getFeishuBotOpenId, resetFeishuBotOpenIdCacheForTest } = await import("./feishu-api");
    resetFeishuBotOpenIdCacheForTest();
    let calls = 0;
    const client = {
      bot: {
        v3: {
          botInfo: {
            get: async () => {
              calls += 1;
              return { code: 0, bot: { open_id: "ou_bot" } };
            },
          },
        },
      },
    };
    const deps = { createClient: () => client as never };
    expect(await getFeishuBotOpenId({ appId: "a", appSecret: "s" }, deps)).toBe("ou_bot");
    expect(await getFeishuBotOpenId({ appId: "a", appSecret: "s" }, deps)).toBe("ou_bot");
    expect(calls).toBe(1);
    // 失败路径
    const failing = {
      createClient: () => ({
        bot: { v3: { botInfo: { get: async () => { throw new Error("down"); } } } },
      }) as never,
    };
    expect(await getFeishuBotOpenId({ appId: "x", appSecret: "y" }, failing)).toBeNull();
  });

  it("getFeishuQuotedMessage 解析 text/post，其他类型给占位说明", async () => {
    const { getFeishuQuotedMessage } = await import("./feishu-api");
    const client = {
      im: {
        v1: {
          message: {
            get: async (req: { params: { message_id: string } }) => {
              if (req.params.message_id === "om_text") {
                return {
                  code: 0,
                  data: { items: [{ msg_type: "text", sender: { id: "ou_1" }, body: { content: JSON.stringify({ text: "被引用的正文" }) } }] },
                };
              }
              if (req.params.message_id === "om_card") {
                return {
                  code: 0,
                  data: { items: [{ msg_type: "interactive", body: { content: JSON.stringify({ title: "工单通知", elements: [{ tag: "div", text: "详情正文" }] }) } }] },
                };
              }
              return { code: 0, data: { items: [] } };
            },
          },
        },
      },
      bot: { v3: { botInfo: { get: async () => ({ code: 0 }) } } },
      cardkit: { v1: { card: { create: async () => ({ code: 0 }), update: async () => ({ code: 0 }) } } },
    } as never;
    const deps = { createClient: () => client };
    const textQuote = await getFeishuQuotedMessage({ appId: "a", appSecret: "s", messageId: "om_text" }, deps);
    expect(textQuote).toEqual({ senderId: "ou_1", text: "被引用的正文" });
    const cardQuote = await getFeishuQuotedMessage({ appId: "a", appSecret: "s", messageId: "om_card" }, deps);
    // #598：引用卡片透传 title + 原始 JSON，模型能读到卡片结构化内容
    expect(cardQuote?.text).toContain("工单通知");
    expect(cardQuote?.text).toContain('"elements"');
    expect(cardQuote?.text).toContain("详情正文");
    expect(await getFeishuQuotedMessage({ appId: "a", appSecret: "s", messageId: "missing" }, deps)).toBeNull();
  });
});

describe("#544 镜像群生命周期", () => {
  it("建群载荷携带群名与目标用户，回传 chat_id；无目标用户允许 bot 占位建群", async () => {
    const captured: unknown[] = [];
    const deps = { createClient: () => makeFakeClient(captured) };
    const res = await createFeishuGroupChat(
      { appId: "cli_x", appSecret: "sec", name: "镜像 · 任务线程", userOpenId: "ou_target" },
      deps,
    );
    expect(res).toEqual({ ok: true, chatId: "oc_new_group" });
    const entry = captureOf(captured, "chat.create") as {
      req: { data: { name: string; user_id_list?: string[] } };
    };
    expect(entry.req.data.name).toBe("镜像 · 任务线程");
    expect(entry.req.data.user_id_list).toEqual(["ou_target"]);

    const captured2: unknown[] = [];
    await createFeishuGroupChat(
      { appId: "cli_x", appSecret: "sec", name: "占位群" },
      { createClient: () => makeFakeClient(captured2) },
    );
    const entry2 = captureOf(captured2, "chat.create") as {
      req: { data: { name: string; user_id_list?: string[] } };
    };
    expect(entry2.req.data.user_id_list).toBeUndefined();
  });

  it("建群业务码≠0 转 ok:false 且错误串保留原始 code（供权限文案映射）", async () => {
    const res = await createFeishuGroupChat(
      { appId: "cli_x", appSecret: "sec", name: "g" },
      { createClient: () => makeFakeClient([], { createChat: { code: 99991672, msg: "forbidden" } }) },
    );
    expect(res.ok).toBe(false);
    expect(res.chatId).toBeUndefined();
    expect(res.error).toContain("99991672");
  });

  it("改名走 path.chat_id + data.name；缺凭据快速失败", async () => {
    const captured: unknown[] = [];
    const res = await updateFeishuChatName(
      { appId: "cli_x", appSecret: "sec", chatId: "oc_g1", name: "新群名" },
      { createClient: () => makeFakeClient(captured) },
    );
    expect(res).toEqual({ ok: true });
    const entry = captureOf(captured, "chat.update") as {
      req: { path: { chat_id: string }; data: { name: string } };
    };
    expect(entry.req.path.chat_id).toBe("oc_g1");
    expect(entry.req.data.name).toBe("新群名");

    const noCreds = await updateFeishuChatName({ appId: "", appSecret: "", chatId: "c", name: "n" });
    expect(noCreds.ok).toBe(false);
    expect(noCreds.error).toContain("App ID");
  });

  it("退群先取缓存机器人身份，再按 open_id members.delete 自身", async () => {
    resetFeishuBotOpenIdCacheForTest();
    const captured: unknown[] = [];
    const res = await leaveFeishuChat(
      { appId: "cli_x", appSecret: "sec", chatId: "oc_g2" },
      { createClient: () => makeFakeClient(captured) },
    );
    expect(res).toEqual({ ok: true });
    const entry = captureOf(captured, "members.delete") as {
      req: {
        path: { chat_id: string };
        params: { member_id_type: string };
        data: { id_list: string[] };
      };
    };
    expect(entry.req.path.chat_id).toBe("oc_g2");
    expect(entry.req.params.member_id_type).toBe("open_id");
    // Bot 身份走缓存后同一假 client 只会返回固定 open_id
    expect(entry.req.data.id_list).toContain("ou_bot");
  });

  it("机器人身份不可得时跳过退群不发删除请求", async () => {
    resetFeishuBotOpenIdCacheForTest();
    const captured: unknown[] = [];
    const res = await leaveFeishuChat(
      { appId: "cli_x", appSecret: "sec", chatId: "oc_g3" },
      { createClient: () => makeFakeClient(captured, { botThrows: true }) },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("机器人身份");
    expect(captureOf(captured, "members.delete")).toBeUndefined();
  });
});
