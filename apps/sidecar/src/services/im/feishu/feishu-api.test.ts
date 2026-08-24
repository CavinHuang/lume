import { describe, it, expect } from "bun:test";
import { sendFeishuText, type FeishuRestClient } from "./feishu-api";

function makeFakeClient(captured: unknown[]): FeishuRestClient {
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
        },
      },
    },
    bot: {
      v3: {
        botInfo: {
          get: async () => ({ code: 0 }),
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
    const res = await sendFeishuText(
      { appId: "a", appSecret: "s", peerId: "c", text: "x" },
      {
        createClient: () => ({
          im: {
            v1: {
              message: {
                create: async () => Promise.reject(new Error("boom")),
                get: async () => ({ code: 0 }),
              },
              chat: {
                get: async () => ({ code: 0 }),
              },
            },
          },
          bot: {
            v3: {
              botInfo: {
                get: async () => ({ code: 0 }),
              },
            },
          },
          cardkit: { v1: { card: { create: async () => ({ code: 0 }), update: async () => ({ code: 0 }) } } },
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
                  data: { items: [{ msg_type: "interactive", body: { content: "{}" } }] },
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
    expect(textQuote).toEqual({ senderOpenId: "ou_1", text: "被引用的正文" });
    const cardQuote = await getFeishuQuotedMessage({ appId: "a", appSecret: "s", messageId: "om_card" }, deps);
    expect(cardQuote?.text).toBe("[卡片消息]");
    expect(await getFeishuQuotedMessage({ appId: "a", appSecret: "s", messageId: "missing" }, deps)).toBeNull();
  });
});
