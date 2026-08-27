import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getImMirrorEntryByChat,
  getImMirrorEntryByThreadId,
  getImMirrorSettings,
  listImMirrorEntries,
  noteMirrorConfigError,
  removeImMirrorEntriesByThreadId,
  removeImMirrorEntriesForAccount,
  setMirrorOwnerAccountId,
  upsertImMirrorEntry
} from "./im-mirror-store";
import { getImMirrorConfigPath } from "../infra/config-paths";

describe("im-mirror-store", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-im-mirror-test-"));
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

  test("owner 默认 off，设置与清除不影响 mirrors 数组", () => {
    expect(getImMirrorSettings().enabledMirrorAccountId).toBeNull();
    upsertImMirrorEntry({ threadId: "t1", accountId: "a1", chatId: "oc_1", carrier: "card" });
    setMirrorOwnerAccountId("a1");
    expect(getImMirrorSettings().enabledMirrorAccountId).toBe("a1");
    expect(listImMirrorEntries()).toHaveLength(1);
    setMirrorOwnerAccountId(null);
    expect(getImMirrorSettings().enabledMirrorAccountId).toBeNull();
    expect(getImMirrorEntryByThreadId("t1")).not.toBeNull();
  });

  test("upsert 按 threadId 幂等，同线程换 chat 跟随最新值且清错误", () => {
    const first = upsertImMirrorEntry({ threadId: "t1", accountId: "a1", chatId: "oc_old", carrier: "card" });
    noteMirrorConfigError("a1", "boom");
    const second = upsertImMirrorEntry({ threadId: "t1", accountId: "a1", chatId: "oc_new", carrier: "card" });
    expect(second.threadId).toBe(first.threadId);
    expect(second.chatId).toBe("oc_new");
    expect(listImMirrorEntries()).toHaveLength(1);
    // 同线程再次落成（重试成功）后账号级历史错误不再展示
    expect(second.lastError).toBeUndefined();
  });

  test("getByChat 以 accountId+chatId 双键命中，防串账号", () => {
    upsertImMirrorEntry({ threadId: "t1", accountId: "a1", chatId: "oc_1", carrier: "card" });
    upsertImMirrorEntry({ threadId: "t2", accountId: "a2", chatId: "oc_1", carrier: "text" });
    expect(getImMirrorEntryByChat("a1", "oc_1")?.threadId).toBe("t1");
    expect(getImMirrorEntryByChat("a2", "oc_1")?.threadId).toBe("t2");
    expect(getImMirrorEntryByChat("a3", "oc_1")).toBeNull();
  });

  test("损坏文件先备份再重建，不抛出且后续写入可用", () => {
    upsertImMirrorEntry({ threadId: "t1", accountId: "a1", chatId: "oc_1", carrier: "card" });
    writeFileSync(getImMirrorConfigPath(), "{not-json", "utf-8");
    expect(getImMirrorSettings().enabledMirrorAccountId).toBeNull();
    expect(listImMirrorEntries()).toHaveLength(0);
    expect(() => setMirrorOwnerAccountId("a2")).not.toThrow();
    expect(getImMirrorSettings().enabledMirrorAccountId).toBe("a2");
  });

  test("noteMirrorConfigError 仅在指向当前承担账号时生效，null 清除", () => {
    setMirrorOwnerAccountId("a1");
    noteMirrorConfigError("a1", "缺少 im:chat 权限");
    expect(getImMirrorSettings().lastError).toBe("缺少 im:chat 权限");
    noteMirrorConfigError("other-account", "不该写入");
    expect(getImMirrorSettings().lastError).toBe("缺少 im:chat 权限");
    noteMirrorConfigError("a1", null);
    expect(getImMirrorSettings().lastError).toBeUndefined();
  });

  test("按线程/按账号移除映射，删承担账号时一并归还 owner 位", () => {
    upsertImMirrorEntry({ threadId: "t1", accountId: "a1", chatId: "oc_1", carrier: "card" });
    upsertImMirrorEntry({ threadId: "t2", accountId: "a2", chatId: "oc_2", carrier: "text" });
    setMirrorOwnerAccountId("a1");

    removeImMirrorEntriesByThreadId("t1");
    expect(listImMirrorEntries().map((entry) => entry.threadId)).toEqual(["t2"]);
    expect(getImMirrorSettings().enabledMirrorAccountId).toBe("a1");

    removeImMirrorEntriesForAccount("a1");
    expect(listImMirrorEntries().map((entry) => entry.threadId)).toEqual(["t2"]);
    expect(getImMirrorSettings().enabledMirrorAccountId).toBeNull();
  });
});
