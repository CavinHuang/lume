import { describe, it, expect, beforeEach } from "bun:test";
import { wecomProvider } from "./wecom-provider";
import { registerWecomClient, __clearWecomClientPoolForTests } from "./wecom-client-pool";
import type { ImRuntimeAccount } from "../im-config-manager";

const makeAccount = (id = "wc-p1"): ImRuntimeAccount =>
  ({
    id,
    provider: "wecom",
    accountKey: "bot",
    token: "sec",
    label: "企业微信",
    enabled: true,
    status: "running",
    hasToken: true,
    createdAt: 0,
    updatedAt: 0,
  }) as ImRuntimeAccount;

beforeEach(() => {
  __clearWecomClientPoolForTests();
});

describe("wecomProvider.sendText", () => {
  it("从连接池取 wsClient 调 sendMessage(markdown 体)", async () => {
    const sent: Array<{ chatid: string; body: unknown }> = [];
    registerWecomClient("wc-p1", {
      sendMessage: async (chatid: string, body: unknown) => {
        sent.push({ chatid, body });
        return {} as never;
      },
    } as never);
    const res = await wecomProvider.sendText({
      account: makeAccount(),
      peerId: "g1",
      peerKind: "group",
      text: "**hi**",
    });
    expect(res.ok).toBe(true);
    expect(sent[0]?.chatid).toBe("g1");
    expect(sent[0]?.body).toEqual({ msgtype: "markdown", markdown: { content: "**hi**" } });
  });

  it("池中无 client 时返回 ok:false", async () => {
    const res = await wecomProvider.sendText({
      account: makeAccount("wc-missing"),
      peerId: "g",
      peerKind: "group",
      text: "x",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("长连接");
  });

  it("sendMessage 抛错返回 ok:false 含错误信息", async () => {
    registerWecomClient("wc-p1", {
      sendMessage: async () => Promise.reject(new Error("send failed")),
    } as never);
    const res = await wecomProvider.sendText({
      account: makeAccount(),
      peerId: "g",
      peerKind: "group",
      text: "x",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("send failed");
  });
});
