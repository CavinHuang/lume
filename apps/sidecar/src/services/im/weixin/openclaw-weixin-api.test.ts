import { describe, expect, test } from "bun:test";
import {
  createOpenClawWeixinApi,
  isOpenClawWeixinAuthError
} from "./openclaw-weixin-api";

describe("openclaw-weixin-api", () => {
  test("getUpdates posts cursor and base info with Alice-compatible auth headers", async () => {
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
      Authorization: "Bearer token-1"
    });
    expect(call.init.headers).not.toHaveProperty("X-WECHAT-UIN");
    expect(call.init.headers).not.toHaveProperty("iLink-App-Id");
    expect(call.init.headers).not.toHaveProperty("iLink-App-ClientVersion");
    expect(JSON.parse(String(call.init.body))).toMatchObject({
      get_updates_buf: "cursor-1",
      base_info: {
        channel_version: "1.0.2"
      }
    });
    expect(batch).toMatchObject({
      cursor: "cursor-2",
      updates: [{
        peerId: "user-1",
        peerKind: "dm",
        text: "hello",
        contents: [{ type: "text", text: "hello" }],
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
        senderId: "user-1",
        text: "group hello",
        contents: [{ type: "text", text: "group hello" }],
        messageId: "456"
      }]
    });
  });

  test("getUpdates parses image-only messages as ImImageContent", async () => {
    const api = createOpenClawWeixinApi({
      baseUrl: "https://ilink.example.com/",
      token: "token-1"
    }, async () => Response.json({
      msgs: [{
        message_id: 789,
        from_user_id: "user-1",
        item_list: [{
          type: 2,
          image_item: { media: {} }
        }]
      }]
    }));

    await expect(api.getUpdates()).resolves.toMatchObject({
      updates: [{
        peerId: "user-1",
        peerKind: "dm",
        senderId: "user-1",
        text: "[图片]",
        contents: [{ type: "image" }],
        messageId: "789"
      }]
    });
  });

  test("getUpdates parses image with full URL and thumbnail", async () => {
    const api = createOpenClawWeixinApi({
      baseUrl: "https://ilink.example.com/",
      token: "token-1"
    }, async () => Response.json({
      msgs: [{
        message_id: 800,
        from_user_id: "user-1",
        item_list: [{
          type: 2,
          image_item: {
            media: { full_url: "https://cdn.example.com/img.jpg" },
            thumb_media: { full_url: "https://cdn.example.com/thumb.jpg" },
            thumb_width: 200,
            thumb_height: 150
          }
        }]
      }]
    }));

    await expect(api.getUpdates()).resolves.toMatchObject({
      updates: [{
        peerId: "user-1",
        contents: [{
          type: "image",
          url: "https://cdn.example.com/img.jpg",
          thumbnailUrl: "https://cdn.example.com/thumb.jpg",
          width: 200,
          height: 150
        }]
      }]
    });
  });

  test("getUpdates parses voice messages with text and playtime", async () => {
    const api = createOpenClawWeixinApi({
      baseUrl: "https://ilink.example.com/",
      token: "token-1"
    }, async () => Response.json({
      msgs: [{
        message_id: 900,
        from_user_id: "user-1",
        item_list: [{
          type: 3,
          voice_item: {
            text: "你好世界",
            playtime: 5000
          }
        }]
      }]
    }));

    await expect(api.getUpdates()).resolves.toMatchObject({
      updates: [{
        peerId: "user-1",
        text: "[语音: 你好世界]",
        contents: [{
          type: "voice",
          text: "你好世界",
          playtime: 5000
        }]
      }]
    });
  });

  test("getUpdates parses voice messages without text", async () => {
    const api = createOpenClawWeixinApi({
      baseUrl: "https://ilink.example.com/",
      token: "token-1"
    }, async () => Response.json({
      msgs: [{
        message_id: 901,
        from_user_id: "user-1",
        item_list: [{
          type: 3,
          voice_item: {
            playtime: 3000
          }
        }]
      }]
    }));

    await expect(api.getUpdates()).resolves.toMatchObject({
      updates: [{
        peerId: "user-1",
        text: "[语音]",
        contents: [{
          type: "voice",
          text: undefined
        }]
      }]
    });
  });

  test("getUpdates parses file messages", async () => {
    const api = createOpenClawWeixinApi({
      baseUrl: "https://ilink.example.com/",
      token: "token-1"
    }, async () => Response.json({
      msgs: [{
        message_id: 1000,
        from_user_id: "user-1",
        item_list: [{
          type: 4,
          file_item: {
            file_name: "report.pdf",
            len: 1024000,
            md5: "abc123"
          }
        }]
      }]
    }));

    await expect(api.getUpdates()).resolves.toMatchObject({
      updates: [{
        peerId: "user-1",
        text: "[文件: report.pdf]",
        contents: [{
          type: "file",
          fileName: "report.pdf",
          fileSize: 1024000,
          md5: "abc123"
        }]
      }]
    });
  });

  test("getUpdates parses file with string len", async () => {
    const api = createOpenClawWeixinApi({
      baseUrl: "https://ilink.example.com/",
      token: "token-1"
    }, async () => Response.json({
      msgs: [{
        message_id: 1001,
        from_user_id: "user-1",
        item_list: [{
          type: 4,
          file_item: {
            file_name: "doc.xlsx",
            len: "2048"
          }
        }]
      }]
    }));

    await expect(api.getUpdates()).resolves.toMatchObject({
      updates: [{
        peerId: "user-1",
        contents: [{
          type: "file",
          fileSize: 2048
        }]
      }]
    });
  });

  test("getUpdates parses video messages", async () => {
    const api = createOpenClawWeixinApi({
      baseUrl: "https://ilink.example.com/",
      token: "token-1"
    }, async () => Response.json({
      msgs: [{
        message_id: 1100,
        from_user_id: "user-1",
        item_list: [{
          type: 5,
          video_item: {
            thumb_media: { full_url: "https://cdn.example.com/video-thumb.jpg" },
            play_length: 15000,
            video_size: 5242880
          }
        }]
      }]
    }));

    await expect(api.getUpdates()).resolves.toMatchObject({
      updates: [{
        peerId: "user-1",
        text: "[视频]",
        contents: [{
          type: "video",
          thumbnailUrl: "https://cdn.example.com/video-thumb.jpg",
          playLength: 15000,
          fileSize: 5242880
        }]
      }]
    });
  });

  test("getUpdates parses mixed text+image messages", async () => {
    const api = createOpenClawWeixinApi({
      baseUrl: "https://ilink.example.com/",
      token: "token-1"
    }, async () => Response.json({
      msgs: [{
        message_id: 1200,
        from_user_id: "user-1",
        item_list: [
          {
            type: 1,
            text_item: { text: "看这个" }
          },
          {
            type: 2,
            image_item: { media: { full_url: "https://cdn.example.com/pic.jpg" } }
          }
        ]
      }]
    }));

    await expect(api.getUpdates()).resolves.toMatchObject({
      updates: [{
        peerId: "user-1",
        text: "看这个 [图片]",
        contents: [
          { type: "text", text: "看这个" },
          { type: "image", url: "https://cdn.example.com/pic.jpg" }
        ]
      }]
    });
  });

  test("getUpdates handles unknown message types as fallback text", async () => {
    const api = createOpenClawWeixinApi({
      baseUrl: "https://ilink.example.com/",
      token: "token-1"
    }, async () => Response.json({
      msgs: [{
        message_id: 1300,
        from_user_id: "user-1",
        item_list: [{
          type: 99
        }]
      }]
    }));

    await expect(api.getUpdates()).resolves.toMatchObject({
      updates: [{
        peerId: "user-1",
        text: "[不支持的消息类型: 99]",
        contents: [{ type: "text", text: "[不支持的消息类型: 99]" }]
      }]
    });
  });

  test("getUpdates falls back to direct text when no item_list", async () => {
    const api = createOpenClawWeixinApi({
      baseUrl: "https://ilink.example.com/",
      token: "token-1"
    }, async () => Response.json({
      msgs: [{
        message_id: 1400,
        from_user_id: "user-1",
        text: "direct message"
      }]
    }));

    await expect(api.getUpdates()).resolves.toMatchObject({
      updates: [{
        peerId: "user-1",
        text: "direct message",
        contents: [{ type: "text", text: "direct message" }]
      }]
    });
  });

  test("getUpdates skips messages with no content and no items", async () => {
    const api = createOpenClawWeixinApi({
      baseUrl: "https://ilink.example.com/",
      token: "token-1"
    }, async () => Response.json({
      msgs: [{
        message_id: 1500,
        from_user_id: "user-1"
      }]
    }));

    await expect(api.getUpdates()).resolves.toMatchObject({
      updates: []
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
