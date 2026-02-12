import { createHash } from "node:crypto";
import { createLiteEmbedding } from "./embeddings-lite";

export type MemoryEmbeddingProvider = "auto" | "lite" | "openai" | "gemini";

export interface ResolvedEmbeddingProvider {
  provider: Exclude<MemoryEmbeddingProvider, "auto">;
  model: string;
  providerKey: string;
  fallbackFrom?: "openai" | "gemini";
  fallbackReason?: string;
}

function hashShort(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function resolveOpenAi(): ResolvedEmbeddingProvider | null {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return null;
  return {
    provider: "openai",
    model: process.env.LUME_MEMORY_OPENAI_MODEL?.trim() || "text-embedding-3-small",
    providerKey: `openai:${hashShort(key)}`
  };
}

function resolveGemini(): ResolvedEmbeddingProvider | null {
  const key = process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
  if (!key) return null;
  return {
    provider: "gemini",
    model: process.env.LUME_MEMORY_GEMINI_MODEL?.trim() || "gemini-embedding-001",
    providerKey: `gemini:${hashShort(key)}`
  };
}

export function resolveEmbeddingProvider(): ResolvedEmbeddingProvider {
  const preferred = (process.env.LUME_MEMORY_PROVIDER?.trim().toLowerCase() || "auto") as MemoryEmbeddingProvider;

  if (preferred === "openai") {
    return resolveOpenAi() ?? {
      provider: "lite",
      model: "lume-lite-embedding-v1",
      providerKey: "lite:default",
      fallbackFrom: "openai",
      fallbackReason: "缺少 OPENAI_API_KEY"
    };
  }

  if (preferred === "gemini") {
    return resolveGemini() ?? {
      provider: "lite",
      model: "lume-lite-embedding-v1",
      providerKey: "lite:default",
      fallbackFrom: "gemini",
      fallbackReason: "缺少 GEMINI_API_KEY/GOOGLE_API_KEY"
    };
  }

  if (preferred === "lite") {
    return {
      provider: "lite",
      model: "lume-lite-embedding-v1",
      providerKey: "lite:default"
    };
  }

  const openai = resolveOpenAi();
  if (openai) return openai;

  const gemini = resolveGemini();
  if (gemini) {
    return {
      ...gemini,
      fallbackFrom: "openai",
      fallbackReason: "缺少 OPENAI_API_KEY，回退到 Gemini"
    };
  }

  return {
    provider: "lite",
    model: "lume-lite-embedding-v1",
    providerKey: "lite:default",
    fallbackFrom: "openai",
    fallbackReason: "缺少 OPENAI_API_KEY/GEMINI_API_KEY，回退到 Lite"
  };
}

async function embedOpenAiBatch(texts: string[], model: string): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("缺少 OPENAI_API_KEY");

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: texts
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`OpenAI embedding 失败: ${response.status} ${detail}`);
  }

  const json = await response.json() as { data?: Array<{ embedding?: number[]; index?: number }> };
  const rows = json.data ?? [];
  if (rows.length === 0) {
    throw new Error("OpenAI embedding 响应为空");
  }

  const result = Array.from({ length: texts.length }, () => [] as number[]);
  for (const row of rows) {
    const idx = typeof row.index === "number" ? row.index : -1;
    if (idx < 0 || idx >= result.length || !Array.isArray(row.embedding)) continue;
    result[idx] = row.embedding;
  }

  if (result.some((item) => item.length === 0)) {
    throw new Error("OpenAI embedding 响应不完整");
  }
  return result;
}

async function embedGeminiOne(text: string, model: string): Promise<number[]> {
  const apiKey = process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
  if (!apiKey) throw new Error("缺少 GEMINI_API_KEY/GOOGLE_API_KEY");

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      content: {
        parts: [{ text }]
      },
      taskType: "RETRIEVAL_DOCUMENT"
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Gemini embedding 失败: ${response.status} ${detail}`);
  }

  const json = await response.json() as { embedding?: { values?: number[] } };
  const values = json.embedding?.values;
  if (!values || !Array.isArray(values)) {
    throw new Error("Gemini embedding 响应无效");
  }
  return values;
}

async function runWithConcurrency<T>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<void>
): Promise<void> {
  if (values.length === 0) return;
  const safe = Math.max(1, concurrency);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(safe, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      const value = values[index];
      if (value === undefined) continue;
      await worker(value, index);
    }
  });

  await Promise.all(runners);
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const safe = Math.max(1, size);
  const result: T[][] = [];
  for (let i = 0; i < values.length; i += safe) {
    result.push(values.slice(i, i + safe));
  }
  return result;
}

export async function embedTextsWithProvider(
  texts: string[],
  resolved: ResolvedEmbeddingProvider,
  opts?: { concurrency?: number; batchSize?: number }
): Promise<number[][]> {
  if (texts.length === 0) return [];

  if (resolved.provider === "lite") {
    return texts.map((text) => createLiteEmbedding(text));
  }

  const batchSize = Math.max(1, opts?.batchSize ?? 32);
  const concurrency = Math.max(1, opts?.concurrency ?? 4);

  if (resolved.provider === "openai") {
    try {
      const chunks = chunkArray(texts, batchSize);
      const result: number[][] = [];
      for (const batch of chunks) {
        const embeddings = await embedOpenAiBatch(batch, resolved.model);
        result.push(...embeddings);
      }
      return result;
    } catch (error) {
      const gemini = resolveGemini();
      if (gemini) {
        return embedTextsWithProvider(texts, gemini, opts);
      }
      throw error;
    }
  }

  if (resolved.provider === "gemini") {
    try {
      const result = Array.from({ length: texts.length }, () => [] as number[]);
      await runWithConcurrency(texts, concurrency, async (text, index) => {
        result[index] = await embedGeminiOne(text, resolved.model);
      });
      return result;
    } catch (error) {
      const openai = resolveOpenAi();
      if (openai) {
        return embedTextsWithProvider(texts, openai, opts);
      }
      throw error;
    }
  }

  return texts.map((text) => createLiteEmbedding(text));
}

export async function embedTextWithProvider(text: string, resolved: ResolvedEmbeddingProvider): Promise<number[]> {
  const rows = await embedTextsWithProvider([text], resolved, { concurrency: 1, batchSize: 1 });
  return rows[0] ?? createLiteEmbedding(text);
}
