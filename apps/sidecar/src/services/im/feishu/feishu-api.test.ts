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
          im: { v1: { message: { create: async () => Promise.reject(new Error("boom")) } } },
        }),
      },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("boom");
  });
});
