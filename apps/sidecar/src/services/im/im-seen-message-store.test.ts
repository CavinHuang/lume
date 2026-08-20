import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getImSeenMessagesPath } from "../infra/config-paths";
import {
  hasSeenImMessage,
  rememberImMessage,
  resetImSeenMessageCacheForTest
} from "./im-seen-message-store";

describe("im-seen-message-store（#157 入站去重）", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-im-seen-test-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
    resetImSeenMessageCacheForTest();
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
    resetImSeenMessageCacheForTest();
  });

  test("remember 后 hasSeen 命中，且跨账号/渠道隔离", () => {
    expect(hasSeenImMessage("dingtalk", "acct-1", "m-1")).toBeFalse();
    rememberImMessage("dingtalk", "acct-1", "m-1");
    expect(hasSeenImMessage("dingtalk", "acct-1", "m-1")).toBeTrue();
    // 同 messageId 不同账号/渠道不去重
    expect(hasSeenImMessage("dingtalk", "acct-2", "m-1")).toBeFalse();
    expect(hasSeenImMessage("wecom", "acct-1", "m-1")).toBeFalse();
  });

  test("remember 持久化落盘且重载缓存后仍命中（跨重启语义）", () => {
    rememberImMessage("feishu", "acct-1", "m-persist");
    const path = getImSeenMessagesPath();
    expect(existsSync(path)).toBeTrue();
    const persisted = JSON.parse(readFileSync(path, "utf-8")) as { entries: Record<string, number> };
    expect(persisted.entries["feishu:acct-1:m-persist"]).toBeNumber();

    // 模拟进程重启：清内存缓存后从文件重载
    resetImSeenMessageCacheForTest();
    expect(hasSeenImMessage("feishu", "acct-1", "m-persist")).toBeTrue();
  });
});
