import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendBoundImMediaMessage } from "./im-send-service";
import { createImAccount } from "./im-config-manager";
import { upsertImThreadBinding } from "./im-thread-binding-store";
import "./weixin/weixin-provider";

describe("im-send-service", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-im-send-test-"));
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

  test("sendBoundImMediaMessage throws for non-existent account", async () => {
    const binding = upsertImThreadBinding({
      provider: "weixin",
      accountId: "acct-nonexistent",
      peerKind: "dm",
      peerId: "peer-1",
      threadId: "thread-1",
    });

    await expect(
      sendBoundImMediaMessage({
        binding,
        mediaType: "image",
        fileData: Buffer.from("fake image"),
        fileName: "test.jpg",
      })
    ).rejects.toThrow();
  });

  test("sendBoundImMediaMessage rejects files over 25MB", async () => {
    const account = createImAccount({
      provider: "weixin",
      token: "fake-token",
      baseUrl: "https://ilink.example.com",
    });
    const binding = upsertImThreadBinding({
      provider: "weixin",
      accountId: account.id,
      peerKind: "dm",
      peerId: "peer-big",
      threadId: "thread-big",
    });

    await expect(
      sendBoundImMediaMessage({
        binding,
        mediaType: "image",
        fileData: Buffer.alloc(26 * 1024 * 1024), // 26MB
        fileName: "huge.jpg",
      })
    ).rejects.toThrow("文件过大");
  });
});
