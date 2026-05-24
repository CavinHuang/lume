import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createImAccount,
  deleteImAccount,
  getImAccountSecret,
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
      enabled: true,
      hasToken: true
    });
    expect(second.hasToken).toBeTrue();
    expect(JSON.stringify(listImAccounts())).not.toContain("token-one");
    expect(readFileSync(getImConfigPath(), "utf-8")).not.toContain("token-one");
    expect(getImAccountSecret(first.id)).toBe("token-one");
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
      status: "running"
    });

    expect(updated).toMatchObject({
      id: first.id,
      label: "主微信",
      enabled: false,
      hasToken: true,
      cursor: "cursor-1",
      contextToken: "ctx-1",
      status: "running"
    });
    expect(getImAccountSecret(first.id)).toBe("token-one-updated");
    expect(getImAccountSecret(second.id)).toBe("token-two");
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
});
