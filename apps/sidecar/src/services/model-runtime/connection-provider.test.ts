import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChannel, listChannels, resolveChannelModelBinding, updateChannel } from "../channel/channel-manager";
import { buildConnectionModelRef, PROVIDER_DEFAULT_URLS } from "@lume/shared";
import {
  getConnectionApiKey,
  getConnectionOAuthCredential,
  installConnectionVaultKey,
  setConnectionOAuthCredential,
} from "../channel/connection-credential-store";
import {
  createConnectionPiAiRoute,
  createLazyConnectionLlmProvider,
  resolveConnectionModelMaxTokens,
} from "./connection-provider";

describe("connection provider", () => {
  let previousConfigDir: string | undefined;
  let directory = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    directory = mkdtempSync(join(tmpdir(), "lume-connection-provider-"));
    process.env.LUME_CONFIG_DIR = directory;
    installConnectionVaultKey(Buffer.alloc(32, 19).toString("base64"));
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = previousConfigDir;
    rmSync(directory, { recursive: true, force: true });
  });

  test("exposes the configured model protocol before the lazy provider resolves", () => {
    const channel = createChannel({
      name: "Anthropic-compatible",
      provider: "custom",
      providerId: "anthropic-compatible",
      protocol: "anthropic-messages",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-test",
      models: [{
        id: "model-1",
        name: "Model 1",
        enabled: true,
        protocol: "anthropic-messages",
      }],
      enabled: true,
    });

    expect(createLazyConnectionLlmProvider({
      connectionId: channel.id,
      modelId: "model-1",
    }).apiType).toBe("anthropic-messages");
  });

  test("switching to an API key removes the previous OAuth credential", () => {
    const channel = createChannel({
      name: "OpenRouter",
      provider: "openrouter",
      authType: "none",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "",
      models: [],
      enabled: true,
    });
    setConnectionOAuthCredential(channel.id, {
      type: "oauth",
      access: "oauth-access",
      refresh: "oauth-refresh",
      expires: Date.now() + 60_000,
    });
    expect(listChannels().find((item) => item.id === channel.id)?.hasOAuthCredential).toBe(true);

    const updated = updateChannel(channel.id, { apiKey: "sk-new" });

    expect(updated.authType).toBe("api-key");
    expect(getConnectionApiKey(channel.id)).toBe("sk-new");
    expect(getConnectionOAuthCredential(channel.id)).toBeUndefined();
  });

  test("clears stale health results when connection credentials change", () => {
    const channel = createChannel({
      name: "OpenAI",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-old",
      models: [],
      enabled: true,
    });
    updateChannel(channel.id, {
      healthStatus: "unavailable",
      healthMessage: "API Key 无效",
      lastTestedAt: 123,
    });

    const updated = updateChannel(channel.id, { apiKey: "sk-new" });

    expect(updated.healthStatus).toBe("unknown");
    expect(updated.healthMessage).toBeUndefined();
    expect(updated.lastTestedAt).toBeUndefined();
  });

  test("changing an OAuth connection provider clears the provider-specific credential", () => {
    const channel = createChannel({
      name: "OpenRouter",
      provider: "openrouter",
      authType: "oauth",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "",
      models: [],
      enabled: true,
    });
    setConnectionOAuthCredential(channel.id, {
      type: "oauth",
      access: "oauth-access",
      refresh: "oauth-refresh",
      expires: Date.now() + 60_000,
    });

    const updated = updateChannel(channel.id, { provider: "openai" });

    expect(updated.authType).toBe("none");
    expect(getConnectionOAuthCredential(channel.id)).toBeUndefined();
  });

  test("an API key always establishes API key authentication on creation", () => {
    const channel = createChannel({
      name: "OpenRouter",
      provider: "openrouter",
      authType: "none",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-new",
      models: [],
      enabled: true,
    });

    expect(channel.authType).toBe("api-key");
    expect(getConnectionApiKey(channel.id)).toBe("sk-new");
  });

  test("does not silently run an OAuth connection without its credential", async () => {
    const channel = createChannel({
      name: "OpenRouter",
      provider: "openrouter",
      authType: "oauth",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "",
      models: [{ id: "model-1", name: "Model 1", enabled: true }],
      enabled: true,
    });

    await expect(createConnectionPiAiRoute({
      channel,
      modelId: "model-1",
    })).rejects.toThrow("connection_oauth_credential_unavailable");
    expect(resolveChannelModelBinding(buildConnectionModelRef(channel.id, "model-1"), "chat")).toBeNull();
  });

  test("does not expose a connection whose API-key credential was lost", async () => {
    const channel = createChannel({
      name: "OpenAI",
      provider: "openai",
      authType: "api-key",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      models: [{ id: "gpt-test", name: "GPT Test", enabled: true, capabilities: { chat: true } }],
      enabled: true,
    });

    expect(resolveChannelModelBinding(buildConnectionModelRef(channel.id, "gpt-test"), "chat")).toBeNull();
    await expect(createConnectionPiAiRoute({ channel, modelId: "gpt-test" }))
      .rejects.toThrow("connection_api_key_unavailable");
  });

  test("rejects disabled connections and disabled catalog models at the provider boundary", async () => {
    const disabledConnection = createChannel({
      name: "Disabled",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [{ id: "gpt-test", name: "GPT Test", enabled: true }],
      enabled: false,
    });
    const disabledModel = createChannel({
      name: "Model Disabled",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: [{ id: "gpt-test", name: "GPT Test", enabled: false }],
      enabled: true,
    });

    await expect(createConnectionPiAiRoute({
      channel: disabledConnection,
      modelId: "gpt-test",
    })).rejects.toThrow("connection_disabled");
    await expect(createConnectionPiAiRoute({
      channel: disabledModel,
      modelId: "gpt-test",
    })).rejects.toThrow("connection_model_disabled");
  });

  test("keeps nested model IDs bound to their exact connection", () => {
    const channel = createChannel({
      name: "OpenRouter",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-test",
      models: [{
        id: "anthropic/claude-sonnet-4-5",
        name: "Claude Sonnet",
        enabled: true,
        capabilities: { chat: true },
      }],
      enabled: true,
    });

    expect(resolveChannelModelBinding(
      buildConnectionModelRef(channel.id, "anthropic/claude-sonnet-4-5"),
      "chat",
    )).toMatchObject({
      channel: { id: channel.id },
      modelId: "anthropic/claude-sonnet-4-5",
      family: "openai",
    });
  });

  test("strips only a connection's own legacy provider prefix from the requested model ID", async () => {
    const channel = createChannel({
      name: "Z.ai",
      provider: "zai",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "zai-key",
      models: [{ id: "zai/glm-custom", name: "GLM Custom", enabled: true }],
      enabled: true,
    });

    await expect(createConnectionPiAiRoute({
      channel,
      modelId: "zai/glm-custom",
    })).resolves.toMatchObject({ modelId: "glm-custom" });
  });

  test("does not guess between ambiguous legacy model references", () => {
    const first = createChannel({
      name: "OpenAI A",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-a",
      models: [{ id: "gpt-shared", name: "Shared", enabled: true, capabilities: { chat: true } }],
      enabled: true,
    });
    const second = createChannel({
      name: "OpenAI B",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-b",
      models: [{ id: "gpt-shared", name: "Shared", enabled: true, capabilities: { chat: true } }],
      enabled: true,
    });

    expect(resolveChannelModelBinding("openai/gpt-shared", "chat")).toBeNull();
    expect(resolveChannelModelBinding("openai/gpt-shared", "chat", second.id)).toMatchObject({
      channel: { id: second.id },
      modelId: "gpt-shared",
    });
    expect(resolveChannelModelBinding(buildConnectionModelRef(first.id, "gpt-shared"), "chat")).toMatchObject({
      channel: { id: first.id },
    });
  });

  test("uses the pi-ai catalog protocol and per-model URL for built-in mixed-protocol providers", async () => {
    const channel = createChannel({
      name: "OpenCode",
      provider: "opencode",
      baseUrl: PROVIDER_DEFAULT_URLS.opencode,
      apiKey: "opencode-key",
      models: [{ id: "big-pickle", name: "Big Pickle", enabled: true }],
      enabled: true,
    });

    expect(createLazyConnectionLlmProvider({
      connectionId: channel.id,
      modelId: "big-pickle",
    }).apiType).toBe("openai-completions");
    await expect(createConnectionPiAiRoute({ channel, modelId: "big-pickle" })).resolves.toMatchObject({
      apiType: "openai-completions",
      baseUrl: "https://opencode.ai/zen/v1",
      contextWindow: 200_000,
      maxTokens: 32_000,
    });
  });

  test("routes catalog-missing multimodal models without guessing transport capability", async () => {
    const channel = createChannel({
      name: "Step Plan",
      provider: "stepfun-coding-plan",
      baseUrl: PROVIDER_DEFAULT_URLS["stepfun-coding-plan"],
      apiKey: "step-key",
      models: [{ id: "step-3.7-flash", name: "Step 3.7 Flash", enabled: true }],
      enabled: true,
    });

    const route = await createConnectionPiAiRoute({ channel, modelId: "step-3.7-flash" });
    expect(route.modelId).toBe("step-3.7-flash");
    expect(route).not.toHaveProperty("supportsImages");
  });

  test("treats an Anthropic-compatible endpoint as an explicit protocol override", async () => {
    const channel = createChannel({
      name: "Z.ai Anthropic",
      provider: "zai",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKey: "zai-key",
      models: [{ id: "glm-custom", name: "GLM Custom", enabled: true }],
      enabled: true,
    });

    expect(channel.protocol).toBe("anthropic-messages");
    expect(createLazyConnectionLlmProvider({
      connectionId: channel.id,
      modelId: "glm-custom",
    }).apiType).toBe("anthropic-messages");
    await expect(createConnectionPiAiRoute({ channel, modelId: "glm-custom" })).resolves.toMatchObject({
      apiType: "anthropic-messages",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
    });
  });

  test("updates the effective protocol when a custom connection changes family", () => {
    const channel = createChannel({
      name: "Custom",
      provider: "custom",
      providerId: "custom-api",
      apiFamily: "openai",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-test",
      models: [{ id: "model-1", name: "Model 1", enabled: true }],
      enabled: true,
    });

    const updated = updateChannel(channel.id, { apiFamily: "anthropic" });

    expect(updated.protocol).toBe("anthropic-messages");
    expect(createLazyConnectionLlmProvider({
      connectionId: channel.id,
      modelId: "model-1",
    }).apiType).toBe("anthropic-messages");
  });

  test("passes catalog thinkingLevelMap and compat through to the route (#561/#631 review)", async () => {
    const channel = createChannel({
      name: "Anthropic",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", enabled: true }],
      enabled: true,
    });

    await expect(createConnectionPiAiRoute({ channel, modelId: "claude-sonnet-4-6" })).resolves.toMatchObject({
      thinkingLevelMap: { max: "max" },
      compat: { forceAdaptiveThinking: true },
      maxTokens: 128_000,
    });
  });

  test("non-catalog models carry no fabricated thinking metadata (#631 review)", async () => {
    const channel = createChannel({
      name: "Custom Gateway",
      provider: "custom",
      providerId: "custom-gateway",
      protocol: "openai-completions",
      baseUrl: "https://gateway.example.com/v1",
      apiKey: "sk-test",
      models: [{ id: "self-hosted-x", name: "Self Hosted", enabled: true }],
      enabled: true,
    });

    const route = await createConnectionPiAiRoute({ channel, modelId: "self-hosted-x" });
    expect(route.thinkingLevelMap).toBeUndefined();
    expect(route.compat).toBeUndefined();
  });

  test("resolveConnectionModelMaxTokens prefers channel config over catalog (#631 review)", () => {
    const channel = createChannel({
      name: "Anthropic",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      models: [
        { id: "claude-sonnet-4-6", name: "Catalog", enabled: true },
        { id: "capped-model", name: "Capped", enabled: true, maxOutputTokens: 8_000 },
        { id: "unknown-model", name: "Unknown", enabled: true },
      ],
      enabled: true,
    });

    // 目录真值 / 用户配置优先 / 双缺返回 undefined(调用方维持默认,不得用兜底猜测)
    expect(resolveConnectionModelMaxTokens(channel, "claude-sonnet-4-6")).toBe(128_000);
    expect(resolveConnectionModelMaxTokens(channel, "capped-model")).toBe(8_000);
    expect(resolveConnectionModelMaxTokens(channel, "unknown-model")).toBeUndefined();
  });
});
