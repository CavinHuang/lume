import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createImAccount,
  deleteImAccount,
  listImAccounts,
  updateImAccount
} from "./im-config-manager";
import { getImConfigPath } from "../infra/config-paths";

describe("im-config-manager", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-im-config-test-"));
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

  test("creates multiple Weixin accounts and redacts stored tokens", () => {
    const first = createImAccount({
      provider: "weixin",
      label: " 工作微信 ",
      token: "token-one",
      uin: "10001",
      baseUrl: "https://ilinkai.weixin.qq.com/",
      workspaceId: "workspace-1",
      enabled: true
    });
    const second = createImAccount({
      provider: "weixin",
      label: "家庭微信",
      token: "token-two",
      uin: "10002",
      enabled: false
    });

    expect(listImAccounts().map((account) => account.id)).toEqual([first.id, second.id]);
    expect(first).toMatchObject({
      provider: "weixin",
      label: "工作微信",
      uin: "10001",
      baseUrl: "https://ilinkai.weixin.qq.com",
      workspaceId: "workspace-1",
      enabled: true,
      hasToken: true
    });
    expect(second.hasToken).toBeTrue();
    expect(JSON.stringify(listImAccounts())).not.toContain("token-one");
    expect(readFileSync(getImConfigPath(), "utf-8")).not.toContain("token-one");
  });

  test("updates one account without replacing siblings", () => {
    const first = createImAccount({
      provider: "weixin",
      label: "工作微信",
      token: "token-one",
      enabled: true
    });
    const second = createImAccount({
      provider: "weixin",
      label: "备用微信",
      token: "token-two",
      enabled: true
    });

    const updated = updateImAccount(first.id, {
      label: "主微信",
      enabled: false,
      token: "token-one-updated",
      cursor: "cursor-1",
      contextToken: "ctx-1",
      workspaceId: "workspace-main",
      status: "running"
    });

    expect(updated).toMatchObject({
      id: first.id,
      label: "主微信",
      enabled: false,
      hasToken: true,
      cursor: "cursor-1",
      contextToken: "ctx-1",
      workspaceId: "workspace-main",
      status: "running"
    });
    expect(listImAccounts().map((account) => account.id)).toEqual([first.id, second.id]);
  });

  test("deletes only the requested account", () => {
    const first = createImAccount({
      provider: "weixin",
      label: "工作微信",
      token: "token-one"
    });
    const second = createImAccount({
      provider: "weixin",
      label: "备用微信",
      token: "token-two"
    });

    deleteImAccount(first.id);

    expect(listImAccounts().map((account) => account.id)).toEqual([second.id]);
  });

  test("损坏的配置文件先备份再重建，不静默清空（#158）", () => {
    createImAccount({
      provider: "weixin",
      label: "损坏前账号",
      token: "token-x",
      enabled: true
    });
    expect(listImAccounts()).toHaveLength(1);

    // 模拟文件截断损坏
    const configPath = getImConfigPath();
    writeFileSync(configPath, "{ \"version\": 1, \"accounts\": [ { \"id\": \"abc\"", "utf-8");

    // 读路径触发备份重建
    const afterCorrupt = listImAccounts();
    expect(afterCorrupt).toEqual([]);

    // 备份保留损坏现场（截断内容），原路径可重新写入
    const backups = readdirSync(tempConfigDir).filter((name) => name.startsWith("im.json.corrupt-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(tempConfigDir, backups[0]!), "utf-8")).toContain("abc");

    const recreated = createImAccount({
      provider: "weixin",
      label: "重建后账号",
      token: "token-y",
      enabled: false
    });
    expect(listImAccounts().map((account) => account.id)).toEqual([recreated.id]);
  });
});
