import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("channel-gateway gateway-service", () => {
  let tempConfigDir = "";
  const oldConfigDir = process.env.LUME_CONFIG_DIR;
  const oldMock = process.env.LUME_PI_AGENT_MOCK_SUCCESS;

  beforeEach(() => {
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-channel-gateway-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
    process.env.LUME_PI_AGENT_MOCK_SUCCESS = "1";
  });

  afterEach(() => {
    if (oldConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = oldConfigDir;
    }
    if (oldMock === undefined) {
      delete process.env.LUME_PI_AGENT_MOCK_SUCCESS;
    } else {
      process.env.LUME_PI_AGENT_MOCK_SUCCESS = oldMock;
    }
    rmSync(tempConfigDir, { recursive: true, force: true });
  });

  test("应基于 externalMessageId 去重", async () => {
    const { createChannel } = await import("../channel-manager");
    const { simulateChannelGatewayIngress } = await import("./gateway-service");
    createChannel({
      name: "mock",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "x",
      models: [{ id: "mock-model", name: "mock-model", enabled: true }],
      enabled: true
    });

    const event = {
      id: "evt-1",
      provider: "telegram" as const,
      externalChatId: "chat-1",
      externalUserId: "user-1",
      externalMessageId: "m-1",
      text: "hello",
      receivedAt: Date.now()
    };
    const first = await simulateChannelGatewayIngress({ event });
    const second = await simulateChannelGatewayIngress({ event });

    expect(first.duplicate).toBeFalse();
    expect(second.duplicate).toBeTrue();
  });

  test("同一 chat 的后续消息应路由到同一 session 绑定", async () => {
    const { createChannel } = await import("../channel-manager");
    const {
      simulateChannelGatewayIngress,
      listChannelGatewayBindings
    } = await import("./gateway-service");
    createChannel({
      name: "mock",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "x",
      models: [{ id: "mock-model", name: "mock-model", enabled: true }],
      enabled: true
    });

    const first = await simulateChannelGatewayIngress({
      event: {
        id: "evt-2",
        provider: "telegram",
        externalChatId: "chat-route",
        externalUserId: "user-route",
        externalMessageId: "m-2",
        text: "first",
        receivedAt: Date.now()
      }
    });
    const second = await simulateChannelGatewayIngress({
      event: {
        id: "evt-3",
        provider: "telegram",
        externalChatId: "chat-route",
        externalUserId: "user-route",
        externalMessageId: "m-3",
        text: "second",
        receivedAt: Date.now()
      }
    });

    const bindings = listChannelGatewayBindings();
    expect(bindings.length).toBe(1);
    expect(first.binding?.sessionId).toBe(second.binding?.sessionId);
  });

  test("执行失败时应写入 retry queue", async () => {
    const { simulateChannelGatewayIngress } = await import("./gateway-service");
    const { listChannelRetryQueue } = await import("./retry-queue-manager");
    const result = await simulateChannelGatewayIngress({
      event: {
        id: "evt-4",
        provider: "telegram",
        externalChatId: "chat-fail",
        externalUserId: "user-fail",
        externalMessageId: "m-4",
        text: "should fail without channel",
        receivedAt: Date.now()
      }
    });
    const retryQueue = listChannelRetryQueue();

    expect(result.accepted).toBeFalse();
    expect(retryQueue.length).toBe(1);
    expect(retryQueue[0]?.reason.length).toBeGreaterThan(0);
  });
});

