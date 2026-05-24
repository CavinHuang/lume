import { describe, expect, test } from "bun:test";
import {
  createOpenClawWeixinApi,
  isOpenClawWeixinAuthError
} from "./openclaw-weixin-api";

describe("openclaw-weixin-api", () => {
  test("getUpdates posts cursor and base info with iLink auth headers", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const api = createOpenClawWeixinApi({
      baseUrl: "https://ilink.example.com/",
      token: "token-1",
      uin: "10001"
    }, async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({
        get_updates_buf: "cursor-2",
        msgs: [{
          message_id: 123,
          from_user_id: "user-1",
          item_list: [{
            type: 1,
            text_item: {
              text: "hello"
            }
          }],
          context_token: "ctx-1"
        }]
      });
    });

    const batch = await api.getUpdates({ cursor: "cursor-1" });
    const call = calls[0];
    if (!call) throw new Error("getUpdates request missing");

    expect(call.url).toBe("https://ilink.example.com/ilink/bot/getupdates");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers).toMatchObject({
      AuthorizationType: "ilink_bot_token",
      Authorization: "Bearer token-1",
      "X-WECHAT-UIN": "10001"
    });
    expect(JSON.parse(String(call.init.body))).toMatchObject({
      get_updates_buf: "cursor-1",
      base_info: {
        uin: "10001"
      }
    });
    expect(batch).toMatchObject({
      cursor: "cursor-2",
      updates: [{
        peerId: "user-1",
        peerKind: "dm",
        text: "hello",
        contextToken: "ctx-1",
        messageId: "123"
      }]
    });
  });

  test("getUpdates maps official group messages by group_id", async () => {
    const api = createOpenClawWeixinApi({
      baseUrl: "https://ilink.example.com/",
      token: "token-1"
    }, async () => Response.json({
      msgs: [{
        message_id: 456,
        from_user_id: "user-1",
        group_id: "room-1",
        item_list: [{
          type: 1,
          text_item: {
            text: "group hello"
          }
        }]
      }]
    }));

    await expect(api.getUpdates()).resolves.toMatchObject({
      updates: [{
        peerId: "room-1",
        peerKind: "group",
        text: "group hello",
        messageId: "456"
      }]
    });
  });

  test("sendText posts one text sendmessage item with context token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const api = createOpenClawWeixinApi({
      baseUrl: "https://ilink.example.com",
      token: "token-1",
      uin: "10001"
    }, async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ ok: true });
    });

    await api.sendText({
      peerId: "room-1",
      peerKind: "group",
      text: "reply",
      contextToken: "ctx-1"
    });
    const call = calls[0];
    if (!call) throw new Error("sendText request missing");

    expect(call.url).toBe("https://ilink.example.com/ilink/bot/sendmessage");
    expect(JSON.parse(String(call.init.body))).toMatchObject({
      msg: {
        from_user_id: "",
        to_user_id: "room-1",
        message_type: 2,
        message_state: 2,
        context_token: "ctx-1",
        item_list: [{
          type: 1,
          text_item: {
            text: "reply"
          }
        }]
      }
    });
  });

  test("notifyStart and notifyStop use official lifecycle endpoints", async () => {
    const calls: string[] = [];
    const api = createOpenClawWeixinApi({
      baseUrl: "https://ilink.example.com",
      token: "token-1"
    }, async (url) => {
      calls.push(String(url));
      return Response.json({ ret: 0 });
    });

    await api.notifyStart();
    await api.notifyStop();

    expect(calls).toEqual([
      "https://ilink.example.com/ilink/bot/msg/notifystart",
      "https://ilink.example.com/ilink/bot/msg/notifystop"
    ]);
  });

  test("AbortError during long poll returns an empty update batch", async () => {
    const api = createOpenClawWeixinApi({
      baseUrl: "https://ilink.example.com",
      token: "token-1"
    }, async () => {
      throw new DOMException("aborted", "AbortError");
    });

    await expect(api.getUpdates({ cursor: "cursor-1" })).resolves.toEqual({
      updates: []
    });
  });

  test("marks 401 and session timeout responses as auth errors", async () => {
    const forbiddenApi = createOpenClawWeixinApi({
      baseUrl: "https://ilink.example.com",
      token: "token-1"
    }, async () => Response.json({ errcode: 401 }, { status: 401 }));

    await forbiddenApi.getUpdates().catch((error) => {
      expect(isOpenClawWeixinAuthError(error)).toBe(true);
    });

    const timeoutApi = createOpenClawWeixinApi({
      baseUrl: "https://ilink.example.com",
      token: "token-1"
    }, async () => Response.json({ errcode: -14, errmsg: "session timeout" }));

    await timeoutApi.getUpdates().catch((error) => {
      expect(isOpenClawWeixinAuthError(error)).toBe(true);
    });
  });
});
