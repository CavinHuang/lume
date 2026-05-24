import { describe, expect, test } from "bun:test";
import {
  getSuggestedProviderModels,
  inferChannelModelCapabilities,
  normalizeChannelModel,
  PROVIDER_API_FAMILIES,
  PROVIDER_DEFAULT_URLS,
  PROVIDER_LABELS,
} from "./channel";

describe("channel model capabilities", () => {
  test("OpenAI embedding 模型应识别 embedding 能力", () => {
    expect(inferChannelModelCapabilities({
      provider: "openai",
      modelId: "text-embedding-3-small"
    })).toEqual({
      chat: false,
      embedding: true
    });
  });

  test("Jina embedding 模型应识别 embedding 能力", () => {
    expect(inferChannelModelCapabilities({
      provider: "jina",
      modelId: "jina-embeddings-v3"
    })).toEqual({
      chat: false,
      embedding: true
    });
  });

  test("BGE-M3 模型应识别 embedding 能力", () => {
    expect(inferChannelModelCapabilities({
      provider: "siliconflow",
      modelId: "BAAI/bge-m3"
    })).toEqual({
      chat: false,
      embedding: true
    });
  });

  test("Google 模型应按 supportedGenerationMethods 推导能力", () => {
    expect(inferChannelModelCapabilities({
      provider: "google",
      modelId: "gemini-embedding-001",
      supportedGenerationMethods: ["embedContent"]
    })).toEqual({
      chat: false,
      embedding: true
    });
    expect(inferChannelModelCapabilities({
      provider: "google",
      modelId: "gemini-2.5-pro",
      supportedGenerationMethods: ["generateContent"]
    })).toEqual({
      chat: true,
      embedding: false
    });
  });

  test("Anthropic 模型默认只标记 chat 能力", () => {
    expect(inferChannelModelCapabilities({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5"
    })).toEqual({
      chat: true
    });
  });

  test("Anthropic 兼容模式应沿用 anthropic 协议族与默认地址", () => {
    expect(PROVIDER_API_FAMILIES["anthropic-compatible"]).toBe("anthropic");
    expect(PROVIDER_DEFAULT_URLS["anthropic-compatible"]).toBe("https://api.anthropic.com");
    expect(PROVIDER_LABELS["anthropic-compatible"]).toBe("Anthropic 兼容模式");
    expect(inferChannelModelCapabilities({
      provider: "anthropic-compatible",
      modelId: "claude-sonnet-4-5"
    })).toEqual({
      chat: true
    });
  });

  test("SiliconFlow 应作为 OpenAI 兼容渠道提供中文 embedding 推荐模型", () => {
    expect(PROVIDER_API_FAMILIES.siliconflow).toBe("openai");
    expect(PROVIDER_DEFAULT_URLS.siliconflow).toBe("https://api.siliconflow.cn/v1");
    expect(PROVIDER_LABELS.siliconflow).toBe("硅基流动");

    const models = getSuggestedProviderModels("siliconflow");
    expect(models.map((model) => model.id)).toEqual([
      "Qwen/Qwen3-Embedding-0.6B",
      "Qwen/Qwen3-Embedding-4B",
      "Qwen/Qwen3-Embedding-8B",
      "BAAI/bge-m3"
    ]);
    expect(models.every((model) => model.enabled && model.capabilities?.embedding === true)).toBe(true);
  });

  test("本地 OpenAI 兼容渠道应有默认地址且不要求特殊能力推断", () => {
    expect(PROVIDER_API_FAMILIES.ollama).toBe("openai");
    expect(PROVIDER_API_FAMILIES.lmstudio).toBe("openai");
    expect(PROVIDER_DEFAULT_URLS.ollama).toBe("http://127.0.0.1:11434/v1");
    expect(PROVIDER_DEFAULT_URLS.lmstudio).toBe("http://127.0.0.1:1234/v1");
    expect(PROVIDER_LABELS.ollama).toBe("Ollama");
    expect(PROVIDER_LABELS.lmstudio).toBe("LM Studio");
  });

  test("normalizeChannelModel 应补齐能力并清理空白", () => {
    expect(normalizeChannelModel({
      provider: "openai",
      id: " text-embedding-3-small ",
      name: " ",
      alias: " emb ",
      enabled: true
    })).toEqual({
      id: "text-embedding-3-small",
      name: "text-embedding-3-small",
      alias: "emb",
      capabilities: {
        chat: false,
        embedding: true
      },
      enabled: true
    });
  });
});
