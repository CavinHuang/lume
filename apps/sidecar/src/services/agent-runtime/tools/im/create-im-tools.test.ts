import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkImTools } from "./create-im-tools";
import { upsertImThreadBinding } from "../../../im/im-thread-binding-store";
import { getToolMetadata } from "../tool-metadata";

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

  test("rejects unbound threads", async () => {
    const [tool] = createSdkImTools({
      threadId: "thread-unbound",
      sendTextMessage: async () => ({ ok: true })
    });
    if (!tool) throw new Error("send_im_message tool missing");

    const result = await tool.call({ text: "hello" }, { cwd: "/tmp" } as never);

    expect(result).toMatchObject({
      type: "tool_result",
      is_error: true
    });
    expect(String(result.content)).toContain("未绑定 IM 会话");
  });

  test("sends only to the bound peer and returns a delivered warning", async () => {
    upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "dm",
      peerId: "user-1",
      threadId: "thread-1",
      contextToken: "ctx-1"
    });
    const sent: Array<{ peerId: string; text: string }> = [];
    const [tool] = createSdkImTools({
      threadId: "thread-1",
      sendTextMessage: async ({ binding, text }) => {
        sent.push({ peerId: binding.peerId, text });
        return { ok: true };
      }
    });
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

  test("registers send_im_message as an execution tool outside plan mode", () => {
    expect(getToolMetadata("send_im_message")).toMatchObject({
      category: "execute",
      riskLevel: "medium",
      allowedInPlanMode: false
    });
  });

  test("sends image via URL when image_url is provided", async () => {
    upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-img",
      peerKind: "dm",
      peerId: "user-img",
      threadId: "thread-img-tool",
      contextToken: "ctx-img",
    });

    const mediaSent: Array<{ mediaType: string; fileName: string }> = [];
    const [tool] = createSdkImTools({
      threadId: "thread-img-tool",
      sendMediaMessage: async (input) => {
        mediaSent.push({ mediaType: input.mediaType, fileName: input.fileName });
        return { ok: true };
      },
    });
    if (!tool) throw new Error("tool missing");

    // Mock fetch to return fake image data
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, statusText: "OK" });

    try {
      const result = await tool.call({
        image_url: "https://example.com/photo.jpg",
      }, { cwd: "/tmp" } as never);

      const parsed = JSON.parse(String(result.content));
      expect(parsed.ok).toBe(true);
      expect(parsed.type).toBe("image");
      expect(mediaSent).toHaveLength(1);
      expect(mediaSent[0]?.mediaType).toBe("image");
      expect(mediaSent[0]?.fileName).toBe("photo.jpg");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sends file via local path when file_path is provided", async () => {
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
    const [tool] = createSdkImTools({
      threadId: "thread-file-tool",
      sendMediaMessage: async (input) => {
        mediaSent.push({ mediaType: input.mediaType, fileName: input.fileName });
        return { ok: true };
      },
    });
    if (!tool) throw new Error("tool missing");

    const result = await tool.call({
      file_path: tempFile,
    }, { cwd: "/tmp" } as never);

    const parsed = JSON.parse(String(result.content));
    expect(parsed.ok).toBe(true);
    expect(parsed.type).toBe("file");
    expect(mediaSent).toHaveLength(1);
    expect(mediaSent[0]?.fileName).toBe("test-file.txt");
  });

  test("text still works as before when only text is provided", async () => {
    upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-text",
      peerKind: "dm",
      peerId: "user-text",
      threadId: "thread-text-tool",
    });

    const textSent: string[] = [];
    const [tool] = createSdkImTools({
      threadId: "thread-text-tool",
      sendTextMessage: async ({ text }) => {
        textSent.push(text);
        return { ok: true };
      },
    });
    if (!tool) throw new Error("tool missing");

    await tool.call({ text: "hello" }, { cwd: "/tmp" } as never);

    expect(textSent).toEqual(["hello"]);
  });

  test("rejects when no text, image_url, or file_path is provided", async () => {
    upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-empty",
      peerKind: "dm",
      peerId: "user-empty",
      threadId: "thread-empty-tool",
    });

    const [tool] = createSdkImTools({
      threadId: "thread-empty-tool",
      sendTextMessage: async () => ({ ok: true }),
    });
    if (!tool) throw new Error("tool missing");

    const result = await tool.call({}, { cwd: "/tmp" } as never);
    expect(result).toMatchObject({ type: "tool_result", is_error: true });
  });
});
