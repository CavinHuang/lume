import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { getImThreadBindingsPath } from "../infra/config-paths";
import { decryptSecret, installSecretEncryptionKey } from "../infra/secret-crypto";
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
    // 统一 v2 形态：contextToken 断言按 roundtrip 写，不依赖 legacy fallback
    installSecretEncryptionKey(randomBytes(32).toString("base64"));
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

  test("#588 并发 F6 LWW:同 peer 异 threadId upsert 换绑到最新线程,contextToken 保留", () => {
    upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "group",
      peerId: "room-1",
      threadId: "thread-1",
      contextToken: "ctx-old"
    });

    // 语义翻转(#588 review F6):并发首消息双建线程时 binding 跟随最新创建,
    // 避免后建线程成孤儿空壳;/new 先删后插不走本分支
    const updated = upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "group",
      peerId: "room-1",
      threadId: "thread-replacement",
      contextToken: "ctx-new"
    });

    expect(updated.threadId).toBe("thread-replacement");
    expect(updated.contextToken && decryptSecret(updated.contextToken)).toBe("ctx-new");
    // 旧线程反查为空(换绑收敛,不双挂)
    expect(getImThreadBindingByThreadId("thread-1")).toBeNull();
    expect(getImThreadBindingByThreadId("thread-replacement")?.key).toBe("weixin/account-1/group/room-1");
  });

  test("#588 空串 threadId 不触发换绑(防御)", () => {
    upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "group",
      peerId: "room-guard",
      threadId: "thread-keep",
      contextToken: "ctx-a"
    });
    const updated = upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "group",
      peerId: "room-guard",
      threadId: "  ",
      contextToken: "ctx-b"
    });
    expect(updated.threadId).toBe("thread-keep");
  });

  test("#598 contextToken（钉钉 sessionWebhook）加密落盘：明文不出现在文件中", () => {
    const webhook = "https://oapi.dingtalk.com/robot/sendBySession?access_token=sekrit-webhook";
    upsertImThreadBinding({
      provider: "dingtalk",
      accountId: "account-1",
      peerKind: "dm",
      peerId: "user-1",
      threadId: "thread-1",
      contextToken: webhook
    });

    const raw = readFileSync(getImThreadBindingsPath(), "utf-8");
    expect(raw).not.toContain(webhook);
    expect(raw).not.toContain("sekrit-webhook");
    const stored = (JSON.parse(raw) as { bindings: Array<{ contextToken?: string }> }).bindings[0]
      ?.contextToken;
    expect(stored?.startsWith("enc:v2:")).toBe(true);
    expect(stored && decryptSecret(stored)).toBe(webhook);
  });

  test("#598 换绑未传 contextToken 时保留存量密文，不重复加密", () => {
    const webhook = "https://oapi.dingtalk.com/robot/sendBySession?access_token=sekrit-keep";
    upsertImThreadBinding({
      provider: "dingtalk",
      accountId: "account-2",
      peerKind: "dm",
      peerId: "user-2",
      threadId: "thread-keep-token",
      contextToken: webhook
    });
    const updated = upsertImThreadBinding({
      provider: "dingtalk",
      accountId: "account-2",
      peerKind: "dm",
      peerId: "user-2",
      threadId: "thread-keep-token-2"
    });

    expect(updated.contextToken?.startsWith("enc:v2:")).toBe(true);
    expect(updated.contextToken && decryptSecret(updated.contextToken)).toBe(webhook);
  });
});
