import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkImTools } from "./create-im-tools";
import { upsertImThreadBinding } from "../../../im/im-thread-binding-store";
import { getToolMetadata } from "../tool-metadata";
import { SafeHttpFetchService } from "../../../infra/safe-http-fetch";

/** 构造器 DI 的安全抓取 fake：resolve 固定公网地址，request 返回固定 PNG 头。 */
function makeFakeFetcher(addresses: string[] = ["93.184.216.34"]) {
  return new SafeHttpFetchService({
    resolve: async (hostname) => addresses.map((address, index) => ({ address, family: index === 1 ? 6 : 4 })),
    request: async () => ({
      status: 200,
      headers: { "content-type": "image/png" },
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    }),
  });
}

describe("create-im-tools", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-im-tool-test-"));
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

  test("send_im_message rejects unbound threads", async () => {
    const tools = createSdkImTools({
      threadId: "thread-unbound",
      sendTextMessage: async () => ({ ok: true })
    });
    const tool = tools.find(t => t.name === "send_im_message");
    if (!tool) throw new Error("send_im_message tool missing");

    const result = await tool.call({ text: "hello" }, { cwd: "/tmp" } as never);

    expect(result).toMatchObject({
      type: "tool_result",
      is_error: true
    });
    expect(String(result.content)).toContain("未绑定 IM 会话");
  });

  test("send_im_message sends only to the bound peer", async () => {
    upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "dm",
      peerId: "user-1",
      threadId: "thread-1",
      contextToken: "ctx-1"
    });
    const sent: Array<{ peerId: string; text: string }> = [];
    const tools = createSdkImTools({
      threadId: "thread-1",
      sendTextMessage: async ({ binding, text }) => {
        sent.push({ peerId: binding.peerId, text });
        return { ok: true };
      }
    });
    const tool = tools.find(t => t.name === "send_im_message");
    if (!tool) throw new Error("send_im_message tool missing");

    const result = await tool.call({
      text: "reply",
      peerId: "malicious-peer"
    }, { cwd: "/tmp" } as never);

    expect(sent).toEqual([{ peerId: "user-1", text: "reply" }]);
    expect(JSON.parse(String(result.content))).toMatchObject({
      ok: true,
      warning: expect.stringContaining("已发送到绑定的 IM 会话")
    });
  });

  test("registers both send_im_message and send_im_media as execute tools", () => {
    expect(getToolMetadata("send_im_message")).toMatchObject({
      category: "execute",
      riskLevel: "medium",
      allowedInPlanMode: false
    });
    expect(getToolMetadata("send_im_media")).toMatchObject({
      category: "execute",
      riskLevel: "medium",
      allowedInPlanMode: false
    });
  });

  test("send_im_media sends image via URL", async () => {
    upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-img",
      peerKind: "dm",
      peerId: "user-img",
      threadId: "thread-img-tool",
      contextToken: "ctx-img",
    });

    const mediaSent: Array<{ mediaType: string; fileName: string }> = [];
    const tools = createSdkImTools({
      threadId: "thread-img-tool",
      mediaFetcher: makeFakeFetcher(),
      sendMediaMessage: async (input) => {
        mediaSent.push({ mediaType: input.mediaType, fileName: input.fileName });
        return { ok: true };
      },
    });
    const tool = tools.find(t => t.name === "send_im_media");
    if (!tool) throw new Error("send_im_media tool missing");

    const result = await tool.call({
      image_url: "https://example.com/photo.jpg",
    }, { cwd: "/tmp" } as never);

    const parsed = JSON.parse(String(result.content));
    expect(parsed.ok).toBe(true);
    expect(parsed.type).toBe("image");
    expect(mediaSent).toHaveLength(1);
    expect(mediaSent[0]?.mediaType).toBe("image");
    expect(mediaSent[0]?.fileName).toBe("photo.jpg");
  });

  test("send_im_media sends file via local path", async () => {
    upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-file",
      peerKind: "dm",
      peerId: "user-file",
      threadId: "thread-file-tool",
    });

    const tempFile = join(tempConfigDir, "test-file.txt");
    writeFileSync(tempFile, "test file content");

    const mediaSent: Array<{ mediaType: string; fileName: string }> = [];
    const tools = createSdkImTools({
      threadId: "thread-file-tool",
      sendMediaMessage: async (input) => {
        mediaSent.push({ mediaType: input.mediaType, fileName: input.fileName });
        return { ok: true };
      },
    });
    const tool = tools.find(t => t.name === "send_im_media");
    if (!tool) throw new Error("send_im_media tool missing");

    const result = await tool.call({
      file_path: tempFile,
    }, { cwd: tempConfigDir } as never);

    const parsed = JSON.parse(String(result.content));
    expect(parsed.ok).toBe(true);
    expect(parsed.type).toBe("file");
    expect(mediaSent).toHaveLength(1);
    expect(mediaSent[0]?.fileName).toBe("test-file.txt");
  });

  test("send_im_media rejects when no image_url or file_path", async () => {
    upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-empty",
      peerKind: "dm",
      peerId: "user-empty",
      threadId: "thread-empty-tool",
    });

    const tools = createSdkImTools({
      threadId: "thread-empty-tool",
      sendTextMessage: async () => ({ ok: true }),
    });
    const tool = tools.find(t => t.name === "send_im_media");
    if (!tool) throw new Error("send_im_media tool missing");

    const result = await tool.call({}, { cwd: "/tmp" } as never);
    expect(result).toMatchObject({ type: "tool_result", is_error: true });
  });

  test("send_im_media rejects unbound threads", async () => {
    const tools = createSdkImTools({
      threadId: "thread-unbound-media",
      sendMediaMessage: async () => ({ ok: true }),
    });
    const tool = tools.find(t => t.name === "send_im_media");
    if (!tool) throw new Error("send_im_media tool missing");

    const result = await tool.call({
      image_url: "https://example.com/img.png",
    }, { cwd: "/tmp" } as never);

    expect(result).toMatchObject({ type: "tool_result", is_error: true });
    expect(String(result.content)).toContain("未绑定 IM 会话");
  });

  test("send_im_media rejects when both image_url and file_path provided", async () => {
    upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-both",
      peerKind: "dm",
      peerId: "user-both",
      threadId: "thread-both-tool",
    });
    const tools = createSdkImTools({
      threadId: "thread-both-tool",
      mediaFetcher: makeFakeFetcher(),
      sendMediaMessage: async () => ({ ok: true }),
    });
    const tool = tools.find(t => t.name === "send_im_media");
    if (!tool) throw new Error("send_im_media tool missing");

    const result = await tool.call({
      image_url: "https://example.com/a.png",
      file_path: "C:/Windows/win.ini",
    }, { cwd: tempConfigDir } as never);

    expect(result).toMatchObject({ type: "tool_result", is_error: true });
    expect(String(result.content)).toContain("只能提供一个");
  });

  test("send_im_media rejects file_path outside workspace and files root", async () => {
    upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-escape",
      peerKind: "dm",
      peerId: "user-escape",
      threadId: "thread-escape-tool",
    });
    const outsideFile = join(tempConfigDir, "..", "lume-im-escape-target.txt");
    writeFileSync(outsideFile, "secret");

    const tools = createSdkImTools({
      threadId: "thread-escape-tool",
      filesRoot: join(tempConfigDir, "files-root"),
      sendMediaMessage: async () => ({ ok: true }),
    });
    const tool = tools.find(t => t.name === "send_im_media");
    if (!tool) throw new Error("send_im_media tool missing");

    try {
      const result = await tool.call({
        file_path: outsideFile,
      }, { cwd: join(tempConfigDir, "workspace") } as never);

      expect(result).toMatchObject({ type: "tool_result", is_error: true });
      expect(String(result.content)).toContain("仅允许工作区或线程文件根");
    } finally {
      rmSync(outsideFile, { force: true });
    }
  });

  test("send_im_media rejects image_url resolving to private network", async () => {
    upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-ssrf",
      peerKind: "dm",
      peerId: "user-ssrf",
      threadId: "thread-ssrf-tool",
    });
    const tools = createSdkImTools({
      threadId: "thread-ssrf-tool",
      // DNS 解析返回云元数据端点地址
      mediaFetcher: makeFakeFetcher(["169.254.169.254"]),
      sendMediaMessage: async () => ({ ok: true }),
    });
    const tool = tools.find(t => t.name === "send_im_media");
    if (!tool) throw new Error("send_im_media tool missing");

    const result = await tool.call({
      image_url: "https://metadata.example.com/token",
    }, { cwd: "/tmp" } as never);

    expect(result).toMatchObject({ type: "tool_result", is_error: true });
    expect(String(result.content)).toContain("下载图片失败");
  });
});
