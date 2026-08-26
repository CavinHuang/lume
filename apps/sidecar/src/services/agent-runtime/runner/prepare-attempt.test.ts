import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChannel } from "../../channel/channel-manager";
import { installConnectionVaultKey } from "../../channel/connection-credential-store";
import { prepareRuntimeCoreAttempt } from "./prepare-attempt";

describe("prepareRuntimeCoreAttempt", () => {
  let previousConfigDir: string | undefined;
  let directory = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    directory = mkdtempSync(join(tmpdir(), "lume-prepare-attempt-"));
    process.env.LUME_CONFIG_DIR = directory;
    installConnectionVaultKey(Buffer.alloc(32, 29).toString("base64"));
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = previousConfigDir;
    rmSync(directory, { recursive: true, force: true });
  });

  test("rejects a disabled connection even when a thread still references it", async () => {
    const channel = createChannel({
      name: "Disabled OpenAI",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [{ id: "gpt-test", name: "GPT Test", enabled: true }],
      enabled: false,
    });

    await expect(prepareRuntimeCoreAttempt({
      input: { threadId: "thread-1", userMessage: "hello" },
      runtime: {
        sessionId: "thread-1",
        channelId: channel.id,
        resolvedModelId: "gpt-test",
      },
    })).resolves.toEqual({
      status: "errored",
      errorMessage: "未找到可用渠道。请到设置 → 连接配置检查渠道是否启用、模型是否可用。",
    });
  });

  test("rejects a connection after all of its chat models are disabled", async () => {
    const channel = createChannel({
      name: "No Chat Models",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [{ id: "gpt-disabled", name: "GPT Disabled", enabled: false }],
      enabled: true,
    });

    await expect(prepareRuntimeCoreAttempt({
      input: { threadId: "thread-2", userMessage: "hello" },
      runtime: {
        sessionId: "thread-2",
        modelRef: `connection:${channel.id}/gpt-disabled`,
        channelId: channel.id,
        resolvedModelId: "gpt-disabled",
      },
    })).resolves.toEqual({
      status: "errored",
      errorMessage: "当前渠道没有已启用的对话模型。请到设置 → 连接配置启用至少一个对话模型。",
    });
  });
});
