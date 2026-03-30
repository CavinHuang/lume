import { describe, expect, test } from "bun:test";
import { embedTextsWithProvider, resolveEmbeddingProvider } from "./embedding";

describe("embedding-provider", () => {
  test("无 key 时 auto 应回退 lite", () => {
    const originalProvider = process.env.LUME_MEMORY_PROVIDER;
    const originalOpenai = process.env.OPENAI_API_KEY;
    const originalGemini = process.env.GEMINI_API_KEY;
    const originalGoogle = process.env.GOOGLE_API_KEY;

    delete process.env.LUME_MEMORY_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    const resolved = resolveEmbeddingProvider();
    expect(resolved.provider).toBe("lite");

    if (originalProvider === undefined) delete process.env.LUME_MEMORY_PROVIDER;
    else process.env.LUME_MEMORY_PROVIDER = originalProvider;
    if (originalOpenai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenai;
    if (originalGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGemini;
    if (originalGoogle === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = originalGoogle;
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
