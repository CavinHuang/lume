import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IM_IPC_CHANNELS } from "@lume/shared";
import { createImHandlers } from "./im-handlers";

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
        getRunningAccountIds: () => [],
        runRecoveryTick: async () => [],
        startAutoRecovery: () => {},
        stopAutoRecovery: () => {}
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
        getRunningAccountIds: () => [],
        runRecoveryTick: async () => [],
        startAutoRecovery: () => {},
        stopAutoRecovery: () => {}
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
