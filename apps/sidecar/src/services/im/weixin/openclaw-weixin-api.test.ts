import { describe, expect, test } from "bun:test";
import { createOpenClawWeixinApi } from "./openclaw-weixin-api";

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
        updates: [{
          peer_id: "user-1",
          peer_kind: "dm",
          peer_name: "Alice",
          text: "hello",
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
        peerName: "Alice",
        text: "hello",
        contextToken: "ctx-1"
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
      to_user_name: "room-1",
      peer_kind: "group",
      message_type: 2,
      message_state: 2,
      context_token: "ctx-1",
      items: [{
        type: 1,
        text: "reply"
      }]
    });
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
});
