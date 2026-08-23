import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createChannel } from "../../channel/channel-manager";
import { installConnectionVaultKey } from "../../channel/connection-credential-store";
import { updateLumeConfigSection } from "../../system/lume-config-service";
import { isRuntimeModelFallbackRetryable, resolveRuntimeModelAttemptParams } from "../runner/attempt";
import type { AgentRuntimeRunParams } from "./types";

describe("resolveRuntimeModelAttemptParams", () => {
  let previousConfigDir: string | undefined;
  let previousSecretSeed: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    previousSecretSeed = process.env.LUME_SECRET_SEED;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-runtime-model-fallback-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
    process.env.LUME_SECRET_SEED = "runtime-model-fallback-test-seed";
    installConnectionVaultKey(Buffer.alloc(32, 7).toString("base64"));
  });

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previousConfigDir;
    }
    if (previousSecretSeed === undefined) {
      delete process.env.LUME_SECRET_SEED;
    } else {
      process.env.LUME_SECRET_SEED = previousSecretSeed;
    }
    rmSync(tempConfigDir, { recursive: true, force: true });
  });

  test("adds configured local fallback model refs as separate runtime attempts", () => {
    const remote = createChannel({
      name: "OpenAI",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "remote-key",
      enabled: true,
      models: [{ id: "gpt-5-mini", name: "gpt-5-mini", enabled: true }]
    });
    const local = createChannel({
      name: "Ollama",
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "",
      enabled: true,
      models: [{ id: "qwen2.5:7b", name: "qwen2.5:7b", enabled: true }]
    });
    updateLumeConfigSection({
      source: "user",
      path: "models.agent.fallbackModelRefs",
      value: ["ollama/qwen2.5:7b"]
    });

    const params: AgentRuntimeRunParams = {
      input: {
        threadId: "thread-1",
        userMessage: "hello",
        permissionMode: "default",
        chatType: "direct"
      },
      runtime: {
        sessionId: "thread-1",
        channelId: remote.id,
        modelRef: "openai/gpt-5-mini",
        resolvedModelId: "gpt-5-mini",
        threadType: "main"
      }
    };

    const attempts = resolveRuntimeModelAttemptParams(params);

    expect(attempts.map((attempt) => attempt.runtime.modelRef)).toEqual([
      "openai/gpt-5-mini",
      "ollama/qwen2.5:7b"
    ]);
    expect(attempts[1]?.runtime.channelId).toBe(local.id);
    expect(attempts[1]?.runtime.resolvedModelId).toBe("qwen2.5:7b");
  });

  test("treats provider outages as fallback retryable but keeps config errors terminal", () => {
    expect(isRuntimeModelFallbackRetryable("Provider returned 503 Service Unavailable")).toBe(true);
    expect(isRuntimeModelFallbackRetryable("connect ECONNREFUSED 127.0.0.1:11434")).toBe(true);
    expect(isRuntimeModelFallbackRetryable("fetch failed")).toBe(true);

    expect(isRuntimeModelFallbackRetryable("401 invalid api key")).toBe(false);
    expect(isRuntimeModelFallbackRetryable("context length exceeded")).toBe(false);
  });
});
