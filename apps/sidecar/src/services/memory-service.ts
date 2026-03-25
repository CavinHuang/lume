import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  getAgentWorkspacePath,
  getWorkspaceMemoryDbPath
} from "./infra/config-paths";
import { MemoryIndexManager } from "./memory/memory-index-manager";
import { getAgentWorkspaceBySlug } from "./agent/agent-workspace-manager";
import { resolveMemoryRuntimeConfig } from "./memory-policy";
import { isMemoryPath, normalizeRelPath } from "./openclaw/memory-path-utils";
import { getEmbeddingCacheStats } from "./memory/embedding-ops";
import type {
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

export async function indexWorkspaceMemory(input: MemoryIndexWorkspaceInput): Promise<{ indexedChunks: number }> {
  const manager = getManager(input.workspaceSlug);
  const indexedChunks = await manager.indexWorkspace(Boolean(input.force));
  return { indexedChunks };
}

export async function indexWorkspaceMemoryFile(input: MemoryIndexFileInput): Promise<{ indexedChunks: number }> {
  const manager = getManager(input.workspaceSlug);
  const indexedChunks = await manager.indexFile(input.filePath, Boolean(input.force));
  return { indexedChunks };
}

export function removeWorkspaceMemoryFile(input: {
  workspaceSlug: string;
  filePath: string;
}): { ok: true } {
  const manager = getManager(input.workspaceSlug);
  manager.removeFile(input.filePath);
  return { ok: true };
}

export async function searchWorkspaceMemory(input: MemorySearchInput): Promise<MemorySearchResult[]> {
  const manager = getManager(input.workspaceSlug);
  const stats = manager.getStats();
  if (stats.chunkCount === 0) {
    await manager.indexWorkspace(false);
  }
  return manager.search({
    query: input.query,
    maxResults: input.maxResults,
    minScore: input.minScore
  });
}

export function getWorkspaceMemoryFile(input: MemoryGetInput): MemoryGetResult {
  const manager = getManager(input.workspaceSlug);
  return manager.readFile({
    path: input.path,
    from: input.from,
    lines: input.lines
  });
}

export function getWorkspaceMemoryStats(workspaceSlug: string): MemoryStats {
  const manager = getManager(workspaceSlug);
  return manager.getStats();
}

export function getWorkspaceMemoryStatus(workspaceSlug: string): MemoryProviderStatus {
  const manager = getManager(workspaceSlug);
  return manager.status();
}

export function getEmbeddingCacheHitStats(): { hits: number; misses: number; hitRate: number } {
  return getEmbeddingCacheStats();
}

export async function saveWorkspaceMemory(input: MemorySaveInput): Promise<MemorySaveResult> {
  const manager = getManager(input.workspaceSlug);
  return manager.saveMemory({
    content: input.content,
    date: input.date,
    path: input.path
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
    removeWorkspaceMemoryFile({ workspaceSlug: input.workspaceSlug, filePath: rel });
    return { indexedChunks: 0, removed: true };
  }

  return indexWorkspaceMemoryFile({
    workspaceSlug: input.workspaceSlug,
    filePath: rel,
    force: true
  });
}

export function closeMemoryManagers(): void {
  for (const manager of managerCache.values()) {
    manager.dispose();
  }
  managerCache.clear();
}
