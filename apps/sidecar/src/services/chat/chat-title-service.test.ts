import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createChannel } from "../channel/channel-manager";
import { generateTitle } from "./chat-title-service";

describe("chat-title-service", () => {
  let prevConfigDir: string | undefined;
  let prevFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    prevFetch = globalThis.fetch;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-chat-title-service-"));
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (prevFetch) {
      globalThis.fetch = prevFetch;
    }
  });

  test("应生成并清洗标题结果", async () => {
    const channel = createChannel({
      name: "openai-title",
      provider: "openai",
      baseUrl: "https://api.openai.com",
      apiKey: "sk-test",
      models: [{ id: "gpt-test", name: "gpt-test", enabled: true }],
      enabled: true
    });

    globalThis.fetch = ((
      async () => new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "\"  这是一个很长的标题候选  \""
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    ) as unknown) as typeof fetch;

    const title = await generateTitle({
      userMessage: "请帮我总结这个需求的标题",
      channelId: channel.id,
      modelId: "gpt-test"
    });

    expect(title).toBe("这是一个很长的标题候选");
  });

  test("渠道不存在时应返回 null", async () => {
    const title = await generateTitle({
      userMessage: "请帮我总结这个需求的标题",
      channelId: "missing-channel",
      modelId: "gpt-test"
    });

    expect(title).toBeNull();
  });
});
