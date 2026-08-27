import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IM_IPC_CHANNELS } from "@lume/shared";
import type { ImMirrorEntryPublic } from "@lume/shared";
import { createImHandlers } from "./im-handlers";
import type { RpcHandler } from "./types";
import { mkdirSync, writeFileSync } from "node:fs";
import { getAgentSessionsIndexPath } from "../services/infra/config-paths";

describe("im-handlers", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-im-rpc-test-"));
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

  test("lists, creates, updates, starts, stops, and deletes IM accounts", async () => {
    const calls: string[] = [];
    const handlers = createImHandlers({
      runtimeManager: {
        startEnabledAccounts: async () => undefined,
        startAccount: async (accountId) => { calls.push(`start:${accountId}`) },
        stopAccount: (accountId) => { calls.push(`stop:${accountId}`) },
        stopAll: () => undefined,
        getRunningAccountIds: () => []
      }
    });

    expect(await handlers[IM_IPC_CHANNELS.LIST_ACCOUNTS]?.({})).toEqual([]);

    const created = await handlers[IM_IPC_CHANNELS.CREATE_ACCOUNT]?.({
      provider: "weixin",
      label: " 工作微信 ",
      token: "token-1",
      uin: "10001",
      enabled: true
    });

    expect(created).toMatchObject({
      provider: "weixin",
      label: "工作微信",
      hasToken: true,
      enabled: true
    });
    expect(JSON.stringify(created)).not.toContain("token-1");

    const id = (created as { id: string }).id;
    const updated = await handlers[IM_IPC_CHANNELS.UPDATE_ACCOUNT]?.({
      id,
      input: {
        label: "主微信",
        enabled: false
      }
    });

    expect(updated).toMatchObject({
      id,
      label: "主微信",
      enabled: false
    });

    await handlers[IM_IPC_CHANNELS.START_ACCOUNT]?.({ id });
    await handlers[IM_IPC_CHANNELS.STOP_ACCOUNT]?.({ id });
    // CREATE_ACCOUNT 对启用账号自动启动通道（创建即闭环），故序列含两次 start
    expect(calls).toEqual([`start:${id}`, `start:${id}`, `stop:${id}`]);

    await handlers[IM_IPC_CHANNELS.DELETE_ACCOUNT]?.({ id });
    expect(await handlers[IM_IPC_CHANNELS.LIST_ACCOUNTS]?.({})).toEqual([]);
  });

  test("starts and polls Weixin QR login", async () => {
    const calls: string[] = [];
    const loginInputs: unknown[] = [];
    const handlers = createImHandlers({
      runtimeManager: {
        startEnabledAccounts: async () => undefined,
        startAccount: async (accountId) => { calls.push(`start:${accountId}`) },
        stopAccount: (accountId) => { calls.push(`stop:${accountId}`) },
        stopAll: () => undefined,
        getRunningAccountIds: () => []
      },
      loginManager: {
        startLogin: async (input) => {
          loginInputs.push(input);
          return {
            sessionKey: "login-1",
            qrcodeUrl: "https://qr.example.com/qr",
            qrcodeImageSrc: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
            message: "scan",
            expiresAt: 123
          };
        },
        pollLogin: async () => ({
          connected: true,
          status: "confirmed",
          message: "ok",
          account: {
            id: "account-1",
            provider: "weixin",
            label: "工作微信",
            baseUrl: "https://ilink.example.com",
            enabled: true,
            status: "stopped",
            hasToken: true,
            createdAt: 1,
            updatedAt: 1
          }
        })
      }
    });

    await expect(handlers[IM_IPC_CHANNELS.START_WEIXIN_LOGIN]?.({
      workspaceId: "workspace-1"
    })).resolves.toMatchObject({
      sessionKey: "login-1",
      qrcodeUrl: "https://qr.example.com/qr",
      qrcodeImageSrc: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="
    });
    await expect(handlers[IM_IPC_CHANNELS.POLL_WEIXIN_LOGIN]?.({
      sessionKey: "login-1"
    })).resolves.toMatchObject({
      connected: true,
      status: "confirmed"
    });
    expect(loginInputs).toEqual([{ workspaceId: "workspace-1" }]);
    expect(calls).toEqual(["start:account-1"]);
  });

  test("starts, polls, and cancels CLI auth", async () => {
    const calls: string[] = [];
    const handlers = createImHandlers({
      authManager: {
        startAuth: async (config) => {
          calls.push(`start:${config.provider}`);
          return { sessionKey: "cli-1", authUrl: "https://login.dingtalk.com/oauth2/auth?x=1" };
        },
        pollAuth: (sessionKey) => {
          calls.push(`poll:${sessionKey}`);
          return { phase: "connected" as const, profile: "u1" };
        },
        cancelAuth: (sessionKey) => {
          calls.push(`cancel:${sessionKey}`);
        },
        stopAll: () => {},
      },
    });

    await expect(handlers[IM_IPC_CHANNELS.START_CLI_AUTH]?.({ provider: "dingtalk" }))
      .resolves.toMatchObject({ sessionKey: "cli-1" });
    await expect(handlers[IM_IPC_CHANNELS.POLL_CLI_AUTH]?.({ sessionKey: "cli-1" }))
      .resolves.toMatchObject({ phase: "connected" });
    await expect(handlers[IM_IPC_CHANNELS.CANCEL_CLI_AUTH]?.({ sessionKey: "cli-1" }))
      .resolves.toEqual({ ok: true });
    expect(calls).toEqual(["start:dingtalk", "poll:cli-1", "cancel:cli-1"]);
  });
});

describe("im-handlers #544 会话镜像", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-im-rpc-mirror-test-"));
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

  function makeHandlers(): Record<string, RpcHandler> {
    return createImHandlers({
      runtimeManager: {
        startEnabledAccounts: async () => undefined,
        startAccount: async () => undefined,
        stopAccount: () => undefined,
        stopAll: () => undefined,
        getRunningAccountIds: () => []
      }
    });
  }

  async function createAccount(provider: "feishu" | "dingtalk", enabled: boolean): Promise<string> {
    const created = (await makeHandlers()[IM_IPC_CHANNELS.CREATE_ACCOUNT]?.({
      provider,
      label: `${provider} 账号`,
      token: "secret",
      accountKey: `cli_${provider}`,
      enabled
    })) as { id: string };
    return created.id;
  }

  test("三个镜像通道已装配且 GET 默认 off", async () => {
    const handlers = makeHandlers();
    expect(handlers[IM_IPC_CHANNELS.MIRROR_GET_SETTINGS]).toBeDefined();
    expect(handlers[IM_IPC_CHANNELS.MIRROR_SET_OWNER]).toBeDefined();
    expect(handlers[IM_IPC_CHANNELS.MIRROR_LIST]).toBeDefined();
    await expect(handlers[IM_IPC_CHANNELS.MIRROR_GET_SETTINGS]?.({})).resolves.toEqual({
      enabledMirrorAccountId: null
    });
  });

  test("SET_OWNER：非法入参拒绝；不存在账号/未启用/不支持渠道均结构化失败", async () => {
    const handlers = makeHandlers();

    await expect(handlers[IM_IPC_CHANNELS.MIRROR_SET_OWNER]?.({ accountId: 42 })).rejects.toThrow();

    const missing = await handlers[IM_IPC_CHANNELS.MIRROR_SET_OWNER]?.({ accountId: "ghost" });
    expect(missing).toMatchObject({ ok: false });
    expect((missing as { error: string }).error).toContain("不存在");

    const disabledId = await createAccount("feishu", false);
    const disabled = await handlers[IM_IPC_CHANNELS.MIRROR_SET_OWNER]?.({ accountId: disabledId });
    expect((disabled as { error: string }).error).toContain("未启用");

    const dingtalkId = await createAccount("dingtalk", true);
    const unsupported = await handlers[IM_IPC_CHANNELS.MIRROR_SET_OWNER]?.({ accountId: dingtalkId });
    expect((unsupported as { error: string }).error).toContain("钉钉");

    // 全程未产生 owner 落盘
    await expect(handlers[IM_IPC_CHANNELS.MIRROR_GET_SETTINGS]?.({})).resolves.toEqual({
      enabledMirrorAccountId: null
    });
  });

  test("SET_OWNER：首个 feishu 账号成功占位；第二家启用冲突失败且占位不变", async () => {
    const firstId = await createAccount("feishu", true);
    const handlers = makeHandlers();

    const first = await handlers[IM_IPC_CHANNELS.MIRROR_SET_OWNER]?.({ accountId: firstId });
    expect(first).toMatchObject({ ok: true, settings: { enabledMirrorAccountId: firstId } });

    const secondId = await createAccount("feishu", true);
    const second = await handlers[IM_IPC_CHANNELS.MIRROR_SET_OWNER]?.({ accountId: secondId });
    expect(second).toMatchObject({ ok: false });
    expect((await handlers[IM_IPC_CHANNELS.MIRROR_GET_SETTINGS]?.({})) as unknown).toMatchObject({
      enabledMirrorAccountId: firstId
    });
  });

  test("LIST 返回映射与线程标题；DELETE 账号联动清映射并归还 owner", async () => {
    const handlers = makeHandlers();
    const feishuId = await createAccount("feishu", true);
    await handlers[IM_IPC_CHANNELS.MIRROR_SET_OWNER]?.({ accountId: feishuId });

    // 直接经 store 造映射（LIST 只读聚合）；线程标题用索引夹具直写（缓存按 mtime 失效）
    const { upsertImMirrorEntry } = await import("../services/im/im-mirror-store");
    const threadId = "thr_list_target";
    mkdirSync(tempConfigDir, { recursive: true });
    writeFileSync(
      getAgentSessionsIndexPath(),
      JSON.stringify({
        version: 1,
        threads: [{ id: threadId, title: "镜像目标线程", createdAt: Date.now(), updatedAt: Date.now() }]
      }),
      "utf-8"
    );
    upsertImMirrorEntry({ threadId, accountId: feishuId, chatId: "oc_l", carrier: "card" });

    const listed = (await handlers[IM_IPC_CHANNELS.MIRROR_LIST]?.({})) as {
      entries: ImMirrorEntryPublic[];
      titles: Record<string, string>;
    };
    expect(listed.entries).toEqual([{ threadId, accountId: feishuId, chatId: "oc_l", carrier: "card", createdAt: expect.any(Number) }]);
    expect(listed.titles[threadId]).toBe("镜像目标线程");

    await handlers[IM_IPC_CHANNELS.DELETE_ACCOUNT]?.({ id: feishuId });
    const afterDelete = (await handlers[IM_IPC_CHANNELS.MIRROR_GET_SETTINGS]?.({})) as {
      enabledMirrorAccountId: string | null;
    };
    expect(afterDelete.enabledMirrorAccountId).toBeNull();
    const listedAfter = (await handlers[IM_IPC_CHANNELS.MIRROR_LIST]?.({})) as { entries: unknown[] };
    expect(listedAfter.entries).toEqual([]);
  });
});
