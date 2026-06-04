import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { getReadingWereadCachePath } from "../infra/config-paths";

const WEREAD_CACHE_VERSION = 1;
const DEFAULT_WEREAD_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const refreshingKeys = new Set<string>();
let cacheGeneration = 0;

interface WereadCacheEntry {
  updatedAt: number;
  expiresAt: number;
  value: unknown;
}

interface WereadCacheFile {
  version: number;
  entries: Record<string, WereadCacheEntry>;
}

export interface WereadCacheOptions {
  now?: () => number;
  ttlMs?: number;
}

export async function cachedWereadCall<T>(
  key: string,
  load: () => Promise<T>,
  options: WereadCacheOptions = {}
): Promise<T> {
  const now = options.now?.() ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_WEREAD_CACHE_TTL_MS;
  const cache = readWereadCache();
  const entry = cache.entries[key];
  if (entry && entry.expiresAt > now) {
    return entry.value as T;
  }
  if (entry) {
    refreshWereadCacheEntry(key, load, options);
    return entry.value as T;
  }

  const value = await load();
  writeWereadCacheEntry(key, {
    updatedAt: now,
    expiresAt: now + ttlMs,
    value
  });
  return value;
}

export function clearWereadCache(): void {
  cacheGeneration += 1;
  refreshingKeys.clear();
  const path = getReadingWereadCachePath();
  if (existsSync(path)) {
    rmSync(path, { force: true });
  }
}

function refreshWereadCacheEntry<T>(
  key: string,
  load: () => Promise<T>,
  options: WereadCacheOptions
): void {
  if (refreshingKeys.has(key)) return;
  const refreshGeneration = cacheGeneration;
  refreshingKeys.add(key);
  void (async () => {
    try {
      const value = await load();
      if (refreshGeneration !== cacheGeneration) return;
      const now = options.now?.() ?? Date.now();
      const ttlMs = options.ttlMs ?? DEFAULT_WEREAD_CACHE_TTL_MS;
      writeWereadCacheEntry(key, {
        updatedAt: now,
        expiresAt: now + ttlMs,
        value
      });
    } catch {
      // Stale cache keeps the UI usable; failed refreshes can retry on the next call.
    } finally {
      refreshingKeys.delete(key);
    }
  })();
}

function writeWereadCacheEntry(key: string, entry: WereadCacheEntry): void {
  const cache = readWereadCache();
  cache.entries[key] = entry;
  writeWereadCache(cache);
}

function readWereadCache(): WereadCacheFile {
  const path = getReadingWereadCachePath();
  if (!existsSync(path)) {
    return createEmptyWereadCache();
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!isRecord(parsed) || parsed.version !== WEREAD_CACHE_VERSION || !isRecord(parsed.entries)) {
      return createEmptyWereadCache();
    }
    return {
      version: WEREAD_CACHE_VERSION,
      entries: Object.fromEntries(Object.entries(parsed.entries).filter((entry): entry is [string, WereadCacheEntry] => {
        const value = entry[1];
        return isRecord(value)
          && typeof value.updatedAt === "number"
          && typeof value.expiresAt === "number"
          && "value" in value;
      }))
    };
  } catch {
    return createEmptyWereadCache();
  }
}

function writeWereadCache(cache: WereadCacheFile): void {
  const path = getReadingWereadCachePath();
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(cache, null, 2), "utf-8");
  renameSync(tmpPath, path);
}

function createEmptyWereadCache(): WereadCacheFile {
  return {
    version: WEREAD_CACHE_VERSION,
    entries: {}
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
