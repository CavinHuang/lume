import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChannel } from "../channel/channel-manager";
import { getLumeConfigYamlPath, getLumeJsonPath } from "../infra/config-paths";
import { embedTextsWithProvider, resolveEmbeddingProvider } from "./embedding";

describe("embedding-provider", () => {
  let prevConfigDir: string | undefined;
  let originalOpenai: string | undefined;
  let originalGemini: string | undefined;
  let originalGoogle: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    originalOpenai = process.env.OPENAI_API_KEY;
    originalGemini = process.env.GEMINI_API_KEY;
    originalGoogle = process.env.GOOGLE_API_KEY;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-embedding-provider-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = prevConfigDir;
    if (originalOpenai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenai;
    if (originalGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGemini;
    if (originalGoogle === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = originalGoogle;
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("无 embedding 配置且无 key 时应回退 lite", () => {
    writeFileSync(getLumeJsonPath(), JSON.stringify({ version: 1 }, null, 2), "utf-8");

    const resolved = resolveEmbeddingProvider();
    expect(resolved.provider).toBe("lite");
  });

  test("lume.yaml 覆盖的 embedding model ref 缺少 key 时应回退 lite", () => {
    writeFileSync(getLumeJsonPath(), JSON.stringify({
      version: 1,
      models: {
        embedding: {
          defaultModelRef: "openai/text-embedding-3-small"
        }
      }
    }, null, 2), "utf-8");
    writeFileSync(getLumeConfigYamlPath(), [
      "version: 1",
      "models:",
      "  embedding:",
      "    defaultModelRef: google/gemini-embedding-001"
    ].join("\n"), "utf-8");

    const resolved = resolveEmbeddingProvider();
    expect(resolved.provider).toBe("lite");
    expect(resolved.fallbackReason).toContain("未配置可用的 Embedding 渠道");
  });

  test("应从已配置渠道解析 openai compatible embedding 凭证", () => {
    createChannel({
      name: "OpenAI",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test-openai",
      enabled: true,
      models: [
        {
          id: "text-embedding-3-small",
          name: "text-embedding-3-small",
          enabled: true,
          capabilities: {
            embedding: true,
            chat: false
          }
        }
      ]
    });
    writeFileSync(getLumeJsonPath(), JSON.stringify({
      version: 1,
      models: {
        embedding: {
          defaultModelRef: "openai/text-embedding-3-small"
        }
      }
    }, null, 2), "utf-8");

    const resolved = resolveEmbeddingProvider();
    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toBe("text-embedding-3-small");
    expect(resolved.baseUrl).toBe("https://api.openai.com/v1");
    expect(resolved.apiKey).toBe("sk-test-openai");
  });

  test("应从 jina embedding 渠道解析 openai compatible 凭证", () => {
    createChannel({
      name: "Jina",
      provider: "jina",
      baseUrl: "https://api.jina.ai/v1",
      apiKey: "jina-test-key",
      enabled: true,
      models: [
        {
          id: "jina-embeddings-v3",
          name: "jina-embeddings-v3",
          enabled: true,
          capabilities: {
            embedding: true,
            chat: false
          }
        }
      ]
    });
    writeFileSync(getLumeJsonPath(), JSON.stringify({
      version: 1,
      models: {
        embedding: {
          defaultModelRef: "jina/jina-embeddings-v3"
        }
      }
    }, null, 2), "utf-8");

    const resolved = resolveEmbeddingProvider();
    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toBe("jina-embeddings-v3");
    expect(resolved.baseUrl).toBe("https://api.jina.ai/v1");
    expect(resolved.apiKey).toBe("jina-test-key");
  });

  test("应从已配置渠道解析 google embedding 凭证", () => {
    createChannel({
      name: "Google",
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "google-test-key",
      enabled: true,
      models: [
        {
          id: "gemini-embedding-001",
          name: "gemini-embedding-001",
          enabled: true,
          capabilities: {
            embedding: true,
            chat: false
          }
        }
      ]
    });
    writeFileSync(getLumeJsonPath(), JSON.stringify({
      version: 1,
      models: {
        embedding: {
          defaultModelRef: "google/gemini-embedding-001"
        }
      }
    }, null, 2), "utf-8");

    const resolved = resolveEmbeddingProvider();
    expect(resolved.provider).toBe("gemini");
    expect(resolved.model).toBe("gemini-embedding-001");
    expect(resolved.baseUrl).toBe("https://generativelanguage.googleapis.com");
    expect(resolved.apiKey).toBe("google-test-key");
  });

  test("lite provider 应支持批量 embedding", async () => {
    const resolved = {
      provider: "lite" as const,
      model: "lume-lite-embedding-v1",
      providerKey: "lite:default"
    };
    const rows = await embedTextsWithProvider(["alpha", "beta", "记忆"], resolved, {
      batchSize: 2,
      concurrency: 2
    });
    expect(rows.length).toBe(3);
    expect(rows[0]?.length).toBeGreaterThan(0);
    expect(rows[2]?.length).toBeGreaterThan(0);
  });
});
