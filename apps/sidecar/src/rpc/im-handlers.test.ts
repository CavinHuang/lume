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
    expect(calls).toEqual([`start:${id}`, `stop:${id}`]);

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
});
