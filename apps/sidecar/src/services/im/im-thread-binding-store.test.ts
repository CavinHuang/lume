import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createImBindingKey,
  getImThreadBindingByPeer,
  getImThreadBindingByThreadId,
  upsertImThreadBinding
} from "./im-thread-binding-store";

describe("im-thread-binding-store", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-im-binding-test-"));
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

  test("binding key includes provider, account, peer kind, and peer id", () => {
    expect(createImBindingKey({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "group",
      peerId: "room-1"
    })).toBe("weixin/account-1/group/room-1");
  });

  test("same peer id under two accounts maps to different threads", () => {
    const first = upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "dm",
      peerId: "user-1",
      peerName: "Alice",
      threadId: "thread-1",
      contextToken: "ctx-1"
    });
    const second = upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-2",
      peerKind: "dm",
      peerId: "user-1",
      peerName: "Alice",
      threadId: "thread-2",
      contextToken: "ctx-2"
    });

    expect(first.key).toBe("weixin/account-1/dm/user-1");
    expect(second.key).toBe("weixin/account-2/dm/user-1");
    expect(getImThreadBindingByPeer({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "dm",
      peerId: "user-1"
    })?.threadId).toBe("thread-1");
    expect(getImThreadBindingByPeer({
      provider: "weixin",
      accountId: "account-2",
      peerKind: "dm",
      peerId: "user-1"
    })?.threadId).toBe("thread-2");
  });

  test("context token updates preserve existing thread and lookup by thread id", () => {
    upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "group",
      peerId: "room-1",
      threadId: "thread-1",
      contextToken: "ctx-old"
    });

    const updated = upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "group",
      peerId: "room-1",
      threadId: "thread-replacement",
      contextToken: "ctx-new"
    });

    expect(updated.threadId).toBe("thread-1");
    expect(updated.contextToken).toBe("ctx-new");
    expect(getImThreadBindingByThreadId("thread-1")?.key).toBe("weixin/account-1/group/room-1");
  });
});
