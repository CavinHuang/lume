/**
 * Unified embedding module for Lume memory.
 * Merged from: embeddings-lite.ts, embedding-provider.ts, embedding-ops.ts
 */

import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";

// ─── Lite embedding (from embeddings-lite.ts) ───

const DEFAULT_DIMS = 1536;

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const lower = input.toLowerCase();

  const ascii = lower.match(/[a-z0-9_]+/g) ?? [];
  tokens.push(...ascii);

  // 提供 CJK 粒度 token，补齐 FTS 英文 token 的盲区
  for (const char of lower) {
    if (/\p{Script=Han}/u.test(char)) {
      tokens.push(char);
    }
  }

  return tokens;
}

function stableHashToInt(token: string, salt: string): number {
  const digest = createHash("sha256").update(`${salt}:${token}`).digest();
  return digest.readUInt32BE(0);
}

export function createLiteEmbedding(text: string, dims = DEFAULT_DIMS): number[] {
  const tokens = tokenize(text);
  if (tokens.length === 0) return Array.from({ length: dims }, () => 0);

  const vec = Array.from({ length: dims }, () => 0);

  for (const token of tokens) {
    const idx = stableHashToInt(token, "idx") % dims;
    const sign = stableHashToInt(token, "sign") % 2 === 0 ? 1 : -1;
    vec[idx] = (vec[idx] ?? 0) + sign;
  }

  // L2 normalize
  const norm = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

// ─── Embedding provider (from embedding-provider.ts) ───

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

// ─── Embedding cache (from embedding-ops.ts) ───

// 内存 LRU 缓存：Map 保持插入顺序，超限时删除最旧条目
const LRU_MAX = 500;
const lruCache = new Map<string, number[]>();

// 缓存命中率统计
const cacheStats = { hits: 0, misses: 0 };

export function getEmbeddingCacheStats(): { hits: number; misses: number; hitRate: number } {
  const total = cacheStats.hits + cacheStats.misses;
  return { ...cacheStats, hitRate: total > 0 ? cacheStats.hits / total : 0 };
}

function lruKey(provider: string, model: string, providerKey: string, hash: string): string {
  return `${provider}:${model}:${providerKey}:${hash}`;
}

function lruGet(key: string): number[] | undefined {
  const val = lruCache.get(key);
  if (val !== undefined) {
    // 移到末尾（最近使用）
    lruCache.delete(key);
    lruCache.set(key, val);
  }
  return val;
}

function lruSet(key: string, val: number[]): void {
  if (lruCache.size >= LRU_MAX) {
    // 删除最旧条目（Map 迭代顺序 = 插入顺序）
    lruCache.delete(lruCache.keys().next().value!);
  }
  lruCache.set(key, val);
}

export interface EmbeddingCacheContext {
  db: Database;
  provider: string;
  model: string;
  providerKey: string;
}

function parseEmbedding(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is number => typeof item === "number");
    }
  } catch {
    // ignore
  }
  return [];
}

export function getCachedEmbedding(params: {
  cache: EmbeddingCacheContext;
  hash: string;
}): number[] | null {
  const key = lruKey(params.cache.provider, params.cache.model, params.cache.providerKey, params.hash);
  const hot = lruGet(key);
  if (hot) { cacheStats.hits++; return hot; }

  const row = params.cache.db
    .query(
      `SELECT embedding FROM embedding_cache
       WHERE provider = ?1 AND model = ?2 AND provider_key = ?3 AND hash = ?4`
    )
    .get(
      params.cache.provider,
      params.cache.model,
      params.cache.providerKey,
      params.hash
    ) as { embedding?: string } | null;

  if (!row?.embedding) { cacheStats.misses++; return null; }
  const parsed = parseEmbedding(row.embedding);
  if (parsed.length > 0) {
    lruSet(key, parsed);
    cacheStats.hits++;
    return parsed;
  }
  cacheStats.misses++;
  return null;
}

export function setCachedEmbedding(params: {
  cache: EmbeddingCacheContext;
  hash: string;
  embedding: number[];
}): void {
  const key = lruKey(params.cache.provider, params.cache.model, params.cache.providerKey, params.hash);
  lruSet(key, params.embedding);

  params.cache.db
    .query(
      `INSERT OR REPLACE INTO embedding_cache
      (provider, model, provider_key, hash, embedding, dims, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    )
    .run(
      params.cache.provider,
      params.cache.model,
      params.cache.providerKey,
      params.hash,
      JSON.stringify(params.embedding),
      params.embedding.length,
      Date.now()
    );
}

export async function embedTextsWithCache(params: {
  texts: string[];
  hashText: (text: string) => string;
  cache: EmbeddingCacheContext;
  embedBatch: (texts: string[]) => Promise<number[][]>;
  embedSingle: (text: string) => Promise<number[]>;
  fallbackLite: (text: string) => number[];
}): Promise<number[][]> {
  if (params.texts.length === 0) return [];

  const result = Array.from({ length: params.texts.length }, () => [] as number[]);
  const misses: Array<{ index: number; text: string; hash: string }> = [];

  params.texts.forEach((text, index) => {
    const hash = params.hashText(text);
    const cached = getCachedEmbedding({
      cache: params.cache,
      hash
    });
    if (cached && cached.length > 0) {
      result[index] = cached;
    } else {
      misses.push({ index, text, hash });
    }
  });

  if (misses.length > 0) {
    let missEmbeddings: number[][];
    try {
      missEmbeddings = await params.embedBatch(misses.map((item) => item.text));
    } catch {
      missEmbeddings = misses.map((item) => params.fallbackLite(item.text));
    }

    misses.forEach((item, missIndex) => {
      const embedding = missEmbeddings[missIndex] ?? params.fallbackLite(item.text);
      result[item.index] = embedding;
      setCachedEmbedding({
        cache: params.cache,
        hash: item.hash,
        embedding
      });
    });
  }

  return result;
}

export async function embedTextWithCache(params: {
  text: string;
  hashText: (text: string) => string;
  cache: EmbeddingCacheContext;
  embedSingle: (text: string) => Promise<number[]>;
  fallbackLite: (text: string) => number[];
}): Promise<number[]> {
  const hash = params.hashText(params.text);
  const cached = getCachedEmbedding({
    cache: params.cache,
    hash
  });
  if (cached && cached.length > 0) {
    return cached;
  }

  let embedding: number[];
  try {
    embedding = await params.embedSingle(params.text);
  } catch {
    embedding = params.fallbackLite(params.text);
  }

  setCachedEmbedding({
    cache: params.cache,
    hash,
    embedding
  });
  return embedding;
}
