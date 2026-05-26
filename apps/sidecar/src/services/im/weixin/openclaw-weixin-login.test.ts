import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenClawWeixinLoginManager } from "./openclaw-weixin-login";

describe("openclaw-weixin-login", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-weixin-login-test-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("starts QR login like Alice and completes into an IM account", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const manager = createOpenClawWeixinLoginManager({
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        if (String(url).includes("get_bot_qrcode")) {
          return Response.json({
            qrcode: "qr-token",
            qrcode_img_content: "https://qr.example.com/qr-token"
          });
        }
        return Response.json({
          status: "confirmed",
          bot_token: "new-token",
          ilink_bot_id: "bot-1",
          ilink_user_id: "user-1",
          baseurl: "https://ilink-redirect.example.com"
        });
      }
    });

    const started = await manager.startLogin({ workspaceId: "workspace-1" });
    const polled = await manager.pollLogin({ sessionKey: started.sessionKey });
    const qrCall = calls[0];
    const pollCall = calls[1];
    if (!qrCall || !pollCall) throw new Error("login requests missing");

    expect(qrCall.url).toBe("https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3");
    expect(qrCall.init.method).toBe("GET");
    expect(qrCall.init.body).toBeUndefined();
    expect(qrCall.init.headers).toBeUndefined();
    expect(pollCall.url).toBe("https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=qr-token");
    expect(pollCall.init.method).toBe("GET");
    expect(pollCall.init.headers).toBeUndefined();
    expect(started.qrcodeUrl).toBe("https://qr.example.com/qr-token");
    expect(started.message).toContain("扫描");
    const qrcodeImageSrc = started.qrcodeImageSrc ?? "";
    expect(qrcodeImageSrc).toStartWith("data:image/svg+xml;base64,");
    expect(atob(qrcodeImageSrc.replace("data:image/svg+xml;base64,", ""))).toContain("<svg");
    expect(polled).toMatchObject({
      connected: true,
      status: "confirmed",
      account: {
        accountKey: "bot-1",
        uin: "user-1",
        workspaceId: "workspace-1",
        baseUrl: "https://ilink-redirect.example.com",
        hasToken: true
      }
    });
  });

  test("redirect status switches polling host for the next poll", async () => {
    let pollCount = 0;
    const pollUrls: string[] = [];
    const manager = createOpenClawWeixinLoginManager({
      fetchImpl: async (url) => {
        if (String(url).includes("get_bot_qrcode")) {
          return Response.json({
            qrcode: "qr-token",
            qrcode_img_content: "https://qr.example.com/qr-token"
          });
        }
        pollCount += 1;
        pollUrls.push(String(url));
        if (pollCount === 1) {
          return Response.json({
            status: "scaned_but_redirect",
            redirect_host: "ilink-2.example.com"
          });
        }
        return Response.json({ status: "wait" });
      }
    });

    const started = await manager.startLogin();
    await manager.pollLogin({ sessionKey: started.sessionKey });
    await manager.pollLogin({ sessionKey: started.sessionKey });

    expect(pollUrls).toEqual([
      "https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=qr-token",
      "https://ilink-2.example.com/ilink/bot/get_qrcode_status?qrcode=qr-token"
    ]);
  });

  test("falls back to the raw qrcode payload when image content is omitted", async () => {
    const manager = createOpenClawWeixinLoginManager({
      fetchImpl: async () => Response.json({
        qrcode: "raw-qr-token"
      })
    });

    const started = await manager.startLogin();

    expect(started).toMatchObject({
      qrcodeUrl: "raw-qr-token"
    });
  });
});
