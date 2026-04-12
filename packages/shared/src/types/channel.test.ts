import { describe, expect, test } from "bun:test";
import { inferChannelModelCapabilities, normalizeChannelModel } from "./channel";

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
