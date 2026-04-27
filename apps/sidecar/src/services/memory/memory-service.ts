// TODO: 评估去掉此转发层，让调用方直接使用 getManager()
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  getConfigDir,
  getAgentWorkspacePath,
  getGlobalMemoryPath,
  getGlobalMemoryDbPath,
  getGlobalStructuredMemoryPath,
  getWorkspaceMemoryDbPath
} from "../infra/config-paths";
import { MemoryIndexManager } from "./memory-index-manager";
import { getAgentWorkspaceBySlug } from "../agent/agent-workspace-manager";
import { resolveMemoryRuntimeConfig } from "./memory-policy";
import { isMemoryPath, normalizeRelPath } from "./memory-path-utils";
import { getEmbeddingCacheStats } from "./embedding";
import { distillWorkspaceMemory } from "./memory-distillation-service";
import { searchGlobalMemory } from "./memory-global-promoter";
import type {
  MemoryDistillationResult,
  MemoryDistillInput,
  MemoryGetInput,
  MemoryGetResult,
  MemoryIndexFileInput,
  MemoryIndexWorkspaceInput,
  MemorySearchInput,
  MemorySearchResult,
  MemorySaveInput,
  MemorySaveResult,
  MemoryProviderStatus,
  MemoryStats
} from "@lume/shared";

const managerCache = new Map<string, MemoryIndexManager>();
const GLOBAL_MEMORY_KEY = "__global__";

function getManager(workspaceSlug: string): MemoryIndexManager {
  const cached = managerCache.get(workspaceSlug);
  if (cached) return cached;

  const workspace = getAgentWorkspaceBySlug(workspaceSlug);
  const runtimeConfig = resolveMemoryRuntimeConfig();
  const manager = new MemoryIndexManager({
    workspaceSlug,
    workspaceRoot: getAgentWorkspacePath(workspaceSlug),
    dbPath: getWorkspaceMemoryDbPath(workspaceSlug),
    workspaceId: workspace?.id,
    sources: runtimeConfig.sources,
    extraPaths: runtimeConfig.extraPaths
  });
  managerCache.set(workspaceSlug, manager);
  return manager;
}

function getGlobalManager(): MemoryIndexManager {
  const cached = managerCache.get(GLOBAL_MEMORY_KEY);
  if (cached) return cached;

  const manager = new MemoryIndexManager({
    workspaceSlug: GLOBAL_MEMORY_KEY,
    workspaceRoot: getConfigDir(),
    dbPath: getGlobalMemoryDbPath(),
    sources: ["memory"],
    extraPaths: [],
    includeWorkspaceBrief: false
  });
  managerCache.set(GLOBAL_MEMORY_KEY, manager);
  return manager;
}

export async function indexWorkspaceMemoryCorpus(input: MemoryIndexWorkspaceInput): Promise<{ indexedChunks: number }> {
  const manager = getManager(input.workspaceSlug);
  const indexedChunks = await manager.indexWorkspace(Boolean(input.force));
  return { indexedChunks };
}

export async function indexWorkspaceMemoryDocument(input: MemoryIndexFileInput): Promise<{ indexedChunks: number }> {
  const manager = getManager(input.workspaceSlug);
  const indexedChunks = await manager.indexFile(input.filePath, Boolean(input.force));
  return { indexedChunks };
}

export function removeWorkspaceMemoryDocument(input: {
  workspaceSlug: string;
  filePath: string;
}): { ok: true } {
  const manager = getManager(input.workspaceSlug);
  manager.removeFile(input.filePath);
  return { ok: true };
}

export async function searchLayeredMemory(input: MemorySearchInput): Promise<MemorySearchResult[]> {
  const manager = getManager(input.workspaceSlug);
  const stats = manager.getStats();
  if (stats.chunkCount === 0) {
    await manager.indexWorkspace(false);
  }
  const limit = input.maxResults ?? 10;
  const workspaceResults = await manager.search({
    query: input.query,
    maxResults: limit,
    minScore: input.minScore,
    scopes: input.scopes,
    kinds: input.kinds,
    sources: input.sources,
    includeRecent: input.includeRecent,
    includeLongTerm: input.includeLongTerm,
    includeWorkspaceBrief: input.includeWorkspaceBrief,
    includeSessions: input.includeSessions,
    strategy: input.strategy
  });

  const includeGlobal = input.includeGlobal ?? true;
  if (!includeGlobal) {
    return workspaceResults.slice(0, limit);
  }

  const globalManager = getGlobalManager();
  const globalStats = globalManager.getStats();
  if (globalStats.chunkCount === 0) {
    await globalManager.indexWorkspace(false);
  }

  const [legacyGlobalResults, structuredGlobalResults] = await Promise.all([
    globalManager.search({
      query: input.query,
      maxResults: limit,
      minScore: input.minScore,
      scopes: input.scopes,
      kinds: input.kinds,
      sources: input.sources,
      includeRecent: input.includeRecent,
      includeLongTerm: input.includeLongTerm,
      includeWorkspaceBrief: input.includeWorkspaceBrief,
      includeSessions: input.includeSessions,
      strategy: input.strategy
    }),
    searchGlobalMemory({
      query: input.query,
      maxResults: limit
    })
  ]);

  const normalizedLegacyGlobalResults = legacyGlobalResults.map((entry) =>
    entry.path === "MEMORY.md" && entry.source === "memory"
      ? { ...entry, path: "~/.lume/MEMORY.md", scope: entry.scope ?? "global" as const }
      : entry
  );

  const structuredGlobalPath = getGlobalStructuredMemoryPath();
  const normalizedStructuredGlobalResults = structuredGlobalResults.map((entry) => ({
    ...entry,
    path: entry.path || structuredGlobalPath,
    scope: entry.scope ?? "global" as const
  }));

  const seen = new Set<string>();
  return [...workspaceResults, ...normalizedStructuredGlobalResults, ...normalizedLegacyGlobalResults]
    .filter((entry) => {
      const key = `${entry.id}:${entry.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function readLayeredMemoryFile(input: MemoryGetInput): MemoryGetResult {
  if (input.path === "~/.lume/MEMORY.md") {
    const manager = getGlobalManager();
    return manager.readFile({
      path: "MEMORY.md",
      from: input.from,
      lines: input.lines
    });
  }
  const manager = getManager(input.workspaceSlug);
  return manager.readFile({
    path: input.path,
    from: input.from,
    lines: input.lines
  });
}

export function getLayeredMemoryStats(workspaceSlug: string): MemoryStats {
  const manager = getManager(workspaceSlug);
  return manager.getStats();
}

export function getLayeredMemoryStatus(workspaceSlug: string): MemoryProviderStatus {
  const manager = getManager(workspaceSlug);
  return manager.status();
}

export function getEmbeddingCacheHitStats(): { hits: number; misses: number; hitRate: number } {
  return getEmbeddingCacheStats();
}

export async function runWorkspaceMemoryDistillation(input: {
  workspaceSlug: string;
  days?: number;
  dryRun?: boolean;
  updateWorkspaceBrief?: boolean;
  generateGlobalCandidates?: boolean;
}): Promise<MemoryDistillationResult> {
  return distillWorkspaceMemory(input as MemoryDistillInput);
}

export async function writeWorkspaceMemory(input: MemorySaveInput): Promise<MemorySaveResult> {
  const manager = getManager(input.workspaceSlug);
  return manager.saveMemory({
    content: input.content,
    date: input.date,
    path: input.path,
    scope: input.scope,
    kind: input.kind,
    source: input.source,
    title: input.title,
    summary: input.summary,
    tags: input.tags,
    entities: input.entities,
    topics: input.topics,
    importance: input.importance,
    confidence: input.confidence,
    sourceSessionId: input.sourceSessionId,
    sourceMessageIds: input.sourceMessageIds,
    sourceToolCallId: input.sourceToolCallId
  });
}

export async function syncWorkspaceMemoryPath(input: {
  workspaceSlug: string;
  absolutePath: string;
}): Promise<{ indexedChunks: number; removed?: true }> {
  const workspaceRoot = getAgentWorkspacePath(input.workspaceSlug);
  const resolvedRoot = resolve(workspaceRoot);
  const resolvedTarget = resolve(input.absolutePath);
  const rel = normalizeRelPath(relative(resolvedRoot, resolvedTarget));

  if (rel.startsWith("..") || rel === "" || rel.startsWith(".claude-plugin/")) {
    return { indexedChunks: 0 };
  }

  if (!isMemoryPath(rel)) {
    return { indexedChunks: 0 };
  }

  if (!existsSync(resolvedTarget)) {
    removeWorkspaceMemoryDocument({ workspaceSlug: input.workspaceSlug, filePath: rel });
    return { indexedChunks: 0, removed: true };
  }

  return indexWorkspaceMemoryDocument({
    workspaceSlug: input.workspaceSlug,
    filePath: rel,
    force: true
  });
}

export async function syncGlobalMemoryPath(input: {
  absolutePath: string;
}): Promise<{ indexedChunks: number; removed?: true }> {
  const globalMemoryPath = resolve(getGlobalMemoryPath());
  const resolvedTarget = resolve(input.absolutePath);
  if (resolvedTarget !== globalMemoryPath) {
    return { indexedChunks: 0 };
  }

  const manager = getGlobalManager();
  if (!existsSync(resolvedTarget)) {
    manager.removeFile("MEMORY.md");
    return { indexedChunks: 0, removed: true };
  }

  const indexedChunks = await manager.indexFile("MEMORY.md", true);
  return { indexedChunks };
}

export function closeMemoryManagers(): void {
  for (const manager of managerCache.values()) {
    manager.dispose();
  }
  managerCache.clear();
}
