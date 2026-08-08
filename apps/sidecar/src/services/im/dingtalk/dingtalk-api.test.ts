import { describe, it, expect } from "bun:test";
import { sendDingtalkText } from "./dingtalk-api";

describe("sendDingtalkText", () => {
  it("POST sessionWebhook (contextToken) 发文本", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const res = await sendDingtalkText(
      { text: "hello", contextToken: "https://oapi.dingtalk.com/robot/sendBySession?session=abc" },
      { fetchImpl: fakeFetch },
    );
    expect(res.ok).toBe(true);
    expect(calls[0]?.url).toContain("robot/sendBySession");
    expect(calls[0]?.body).toEqual({ msgtype: "text", text: { content: "hello" } });
  });

  it("缺 contextToken 时返回 ok:false", async () => {
    const res = await sendDingtalkText(
      { text: "x", contextToken: undefined },
      { fetchImpl: (async () => new Response()) as unknown as typeof fetch },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("sessionWebhook");
  });

  it("HTTP 非 2xx 时返回 ok:false 含状态码", async () => {
    const fakeFetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const res = await sendDingtalkText({ text: "x", contextToken: "https://hw" }, { fetchImpl: fakeFetch });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("500");
  });
});
