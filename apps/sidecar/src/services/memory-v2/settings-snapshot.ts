import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  MemoryKind,
  MemoryPendingCounts,
  MemorySettingsEntrySummary,
  MemorySettingsFileSummary,
  MemorySettingsPendingSummary,
  MemorySettingsSnapshot
} from "@lume/shared";
import {
  MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_LABEL,
  MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_REF
} from "@lume/shared";
import { getMemoryV2ScopePaths } from "./paths";
import { createMemoryV2Store } from "./markdown-store";
import { resolveMemoryEmbeddingModelRef, resolveMemoryEmbeddingStatusModelRef } from "./embedding";
import { getLocalOnnxMemoryEmbeddingStatus } from "./local-embedding";
import { resolveMemoryRerankModelRef } from "./rerank";
import { getSemanticIndexStatus } from "./semantic-index";
import { getEffectiveLumeConfig } from "../system/lume-config-service";
import { getMemoryRuntimeConfig } from "./policy";
import type { MemoryV2Entry, MemoryV2Kind, MemoryV2PendingItem, MemoryV2Status } from "./types";

export function getMemoryV2SettingsSnapshot(workspaceSlug: string): MemorySettingsSnapshot {
  const store = createMemoryV2Store();
  const workspacePaths = getMemoryV2ScopePaths({ scope: "workspace", workspaceSlug });
  const globalPaths = getMemoryV2ScopePaths({ scope: "global" });
  const workspaceEntries = store.listEntries({
    workspaceSlug,
    scopes: ["workspace"],
    includeStatuses: ["active", "suspected_stale", "archived", "superseded", "pending_conflict", "pending_low_confidence"]
  });
  const globalEntries = store.listEntries({
    scopes: ["global"],
    includeStatuses: ["active", "suspected_stale", "archived", "superseded", "pending_conflict", "pending_low_confidence"]
  });
  const pending = store.listPending({
    workspaceSlug,
    scopes: ["workspace", "global"]
  });
  const runtimeConfig = getMemoryRuntimeConfig();
  const lumeConfig = getEffectiveLumeConfig(workspaceSlug);
  const embeddingModelRef = resolveMemoryEmbeddingModelRef(lumeConfig);
  const semanticModelRef = resolveMemoryEmbeddingStatusModelRef(lumeConfig);
  const localOnnx = getLocalOnnxMemoryEmbeddingStatus();
  const semanticStatus = getSemanticIndexStatus({
    workspaceSlug,
    semantic: runtimeConfig.retrieval.semantic,
    embeddingModelRef: semanticModelRef
  });
  const rerank = resolveMemoryRerankModelRef({
    workspaceSlug,
    explicitModelRef: runtimeConfig.retrieval.rerankModelRef
  });
  const openPending = pending.filter((item) => item.frontmatter.status === "open");
  const dailyFiles = listFiles(workspacePaths.dailyDir, "daily", "workspace");
  const runFiles = listFiles(workspacePaths.runsDir, "run", "workspace");
  const files: MemorySettingsFileSummary[] = [
    memoryFileSummary(workspacePaths.memoryMd, "Workspace MEMORY.md", "workspace"),
    memoryFileSummary(globalPaths.memoryMd, "Global MEMORY.md", "global"),
    ...dailyFiles,
    ...runFiles
  ];
  return {
    workspaceSlug,
    counts: {
      active: countStatus([...workspaceEntries, ...globalEntries], "active"),
      workspace: workspaceEntries.length,
      global: globalEntries.length,
      suspectedStale: countStatus([...workspaceEntries, ...globalEntries], "suspected_stale"),
      pinned: [...workspaceEntries, ...globalEntries].filter((entry) => entry.frontmatter.pinned).length,
      daily: dailyFiles.length,
      runs: runFiles.length,
      pending: countPending(openPending)
    },
    files,
    workspaceEntries: workspaceEntries.map(entrySummary),
    globalEntries: globalEntries.map(entrySummary),
    pending: pending.map(pendingSummary),
    retrieval: {
      semantic: {
        mode: runtimeConfig.retrieval.semantic,
        ...(embeddingModelRef ? { embeddingModelRef } : {}),
        ...(semanticModelRef && !embeddingModelRef ? { fallbackModelRef: semanticModelRef } : {}),
        status: semanticStatus.status,
        message: embeddingModelRef
          ? semanticStatus.message
          : `${semanticStatus.message}；未配置远程 embedding 时会使用本地 ONNX`,
        localOnnx: {
          modelRef: MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_REF,
          label: MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_LABEL,
          status: localOnnx.status,
          cacheDir: localOnnx.cacheDir,
          message: localOnnxStatusMessage(localOnnx.status),
          ...(localOnnx.error ? { error: localOnnx.error } : {})
        }
      },
      rerank: {
        ...(rerank.modelRef ? { modelRef: rerank.modelRef } : {}),
        source: rerank.source
      }
    }
  };
}

function localOnnxStatusMessage(status: ReturnType<typeof getLocalOnnxMemoryEmbeddingStatus>["status"]): string {
  if (status === "ready") return "本地 ONNX 模型已加载，语义召回可直接使用。";
  if (status === "cached") return "本地 ONNX 模型已缓存，首次召回时会快速初始化。";
  if (status === "downloading") return "正在下载并初始化本地 ONNX 模型，首次使用可能需要一点时间。";
  if (status === "initializing") return "正在初始化本地 ONNX 模型。";
  if (status === "failed") return "本地 ONNX 模型初始化失败，当前会继续使用基础召回。";
  return "本地 ONNX 模型尚未缓存，首次使用语义召回时会自动下载。";
}

function memoryFileSummary(path: string, label: string, scope: "global" | "workspace"): MemorySettingsFileSummary {
  return {
    path,
    label,
    kind: "memory",
    scope,
    updatedAt: fileUpdatedAt(path)
  };
}

function listFiles(
  dir: string | undefined,
  kind: MemorySettingsFileSummary["kind"],
  scope: "global" | "workspace"
): MemorySettingsFileSummary[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .map((entry) => join(dir, entry))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => (fileUpdatedAt(b) ?? 0) - (fileUpdatedAt(a) ?? 0))
    .slice(0, 20)
    .map((path) => ({
      path,
      label: basename(path),
      kind,
      scope,
      updatedAt: fileUpdatedAt(path)
    }));
}

function entrySummary(entry: MemoryV2Entry): MemorySettingsEntrySummary {
  return {
    id: entry.frontmatter.id,
    path: entry.path,
    scope: entry.frontmatter.scope,
    kind: fromV2Kind(entry.frontmatter.kind),
    status: entry.frontmatter.status,
    confidence: entry.frontmatter.confidence,
    statement: entry.statement,
    updated: entry.frontmatter.updated,
    pinned: entry.frontmatter.pinned,
    tags: entry.frontmatter.tags
  };
}

function pendingSummary(item: MemoryV2PendingItem): MemorySettingsPendingSummary {
  return {
    id: item.frontmatter.id,
    path: item.path,
    type: item.frontmatter.type,
    status: item.frontmatter.status,
    created: item.frontmatter.created,
    statement: item.frontmatter.candidate.statement,
    reason: item.frontmatter.reason,
    existingIds: item.frontmatter.existing?.ids ?? []
  };
}

function countStatus(entries: MemoryV2Entry[], status: MemoryV2Status): number {
  return entries.filter((entry) => entry.frontmatter.status === status).length;
}

function countPending(items: MemoryV2PendingItem[]): MemoryPendingCounts {
  const conflicts = items.filter((item) => item.frontmatter.type === "conflict").length;
  const stale = items.filter((item) => item.frontmatter.type === "stale").length;
  const lowConfidence = items.filter((item) => item.frontmatter.type === "low-confidence").length;
  return {
    conflicts,
    stale,
    lowConfidence,
    total: conflicts + stale + lowConfidence
  };
}

function fileUpdatedAt(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function fromV2Kind(kind: MemoryV2Kind): MemoryKind {
  return kind === "state" ? "summary" : kind;
}
