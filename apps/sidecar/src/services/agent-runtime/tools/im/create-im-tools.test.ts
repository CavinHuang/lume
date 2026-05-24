import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
});
