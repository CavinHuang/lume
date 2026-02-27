/**
 * Migrated style from OpenClaw manager embedding ops:
 * /Users/cavinhuang/workspace/projects/test/openclaw/src/memory/manager-embedding-ops.ts
 * Adaptation:
 * - Keep Bun sqlite API used by Lume sidecar.
 */

import { Database } from "bun:sqlite";

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
