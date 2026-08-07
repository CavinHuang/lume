import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  MemoryKind,
  MemoryMutationChange,
  MemoryMutationEntrySnapshot,
  MemoryPendingCounts,
  MemorySettingsActivityItem,
  MemorySettingsEntrySummary,
  MemorySettingsFileSummary,
  MemorySettingsPendingSummary,
  MemorySettingsSnapshot,
  MemoryDiagnosticsSnapshot
} from "@lume/shared";
import type { MemoryMutationReceipt } from "@lume/shared";
import {
  MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_LABEL,
  MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_REF
} from "@lume/shared";
import { getMemoryV2ScopePaths } from "./paths";
import { createMemoryV2Store, readActivation } from "./markdown-store";
import { resolveMemoryEmbeddingModelRef, resolveMemoryEmbeddingStatusModelRef } from "./embedding";
import { resolveMemoryExtractionModelRef } from "./extraction";
import { getLocalOnnxMemoryEmbeddingStatus } from "./local-embedding";
import { resolveMemoryRerankModelRef } from "./rerank";
import { getSemanticIndexStatus } from "./semantic-index";
import { getEffectiveLumeConfig } from "../system/lume-config-service";
import { getMemoryRuntimeConfig } from "./policy";
import { memoryJobService } from "./job-service";
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
  const diagnostics = getMemoryDiagnosticsState(workspaceSlug, workspacePaths);
  const openPending = pending.filter((item) => item.frontmatter.status === "open");
  const entryById = new Map([...workspaceEntries, ...globalEntries].map((entry) => [entry.frontmatter.id, entry]));
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
    pending: pending.map((item) => pendingSummary(item, entryById)),
    activity: readRecentActivity([workspacePaths.journalDir, globalPaths.journalDir], entryById),
    ...(existsSync(workspacePaths.workspaceBrief) ? {
      workspaceBrief: {
        path: workspacePaths.workspaceBrief,
        markdown: readFileSync(workspacePaths.workspaceBrief, "utf-8"),
        updatedAt: fileUpdatedAt(workspacePaths.workspaceBrief)
      }
    } : {}),
    ...diagnostics
  };
}

export function getMemoryV2DiagnosticsSnapshot(workspaceSlug: string): MemoryDiagnosticsSnapshot {
  const workspacePaths = getMemoryV2ScopePaths({ scope: "workspace", workspaceSlug });
  return {
    workspaceSlug,
    ...getMemoryDiagnosticsState(workspaceSlug, workspacePaths)
  };
}

function getMemoryDiagnosticsState(
  workspaceSlug: string,
  workspacePaths: ReturnType<typeof getMemoryV2ScopePaths>
): Omit<MemoryDiagnosticsSnapshot, "workspaceSlug"> {
  const runtimeConfig = getMemoryRuntimeConfig();
  const lumeConfig = getEffectiveLumeConfig(workspaceSlug);
  const extractionModelRef = resolveMemoryExtractionModelRef(lumeConfig);
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
  return {
    jobs: memoryJobService.list(workspaceSlug).slice(0, 20).map((job) => ({
      jobId: job.jobId,
      kind: job.kind,
      status: job.status,
      createdAt: job.createdAt,
      retryable: job.kind === "external_ingest"
        && (job.status === "failed" || job.status === "cancelled" || job.status === "interrupted")
        && job.payload !== undefined,
      ...(job.completedAt ? { completedAt: job.completedAt } : {}),
      ...(job.error ? { error: job.error } : {})
    })),
    migration: {
      schemaVersion: readSchemaVersion(workspacePaths.schemaMarker),
      backupPaths: listBackupPaths(workspacePaths.root)
    },
    extraction: {
      ...(extractionModelRef ? { modelRef: extractionModelRef } : {}),
      source: extractionModelRef ? "configured" : "disabled",
      message: extractionModelRef
        ? "已配置记忆提取模型，外部资料会优先使用 LLM 分析。"
        : "未配置记忆提取模型；外部资料只会使用显式记忆句式。"
    },
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

interface MutationJournalRecord {
  receipt?: MemoryMutationReceipt;
  before?: MemoryMutationEntrySnapshot[];
  after?: MemoryMutationEntrySnapshot[];
}

function readRecentActivity(
  journalDirs: string[],
  entryById: Map<string, MemoryV2Entry>
): MemorySettingsActivityItem[] {
  const activity: MemorySettingsActivityItem[] = [];
  for (const dir of journalDirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((item) => item.endsWith(".jsonl"))) {
      try {
        for (const line of readFileSync(join(dir, name), "utf-8").split(/\r?\n/).filter(Boolean)) {
          try {
            const parsed = JSON.parse(line) as MutationJournalRecord;
            if (parsed.receipt) activity.push({
              ...parsed.receipt,
              changes: buildMutationChanges(parsed, entryById)
            });
          } catch {
            // A malformed line must not hide valid activity from the same journal.
          }
        }
      } catch {
        // A malformed journal must not make memory settings unavailable.
      }
    }
  }
  return activity.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
}

function buildMutationChanges(
  record: MutationJournalRecord,
  entryById: Map<string, MemoryV2Entry>
): MemoryMutationChange[] {
  if (!record.receipt) return [];
  const before = new Map((record.before ?? []).map((item) => [item.id, item]));
  const after = new Map((record.after ?? []).map((item) => [item.id, item]));
  const ids = [...new Set([
    ...record.receipt.memoryIds,
    ...before.keys(),
    ...after.keys()
  ])];
  const exact = [...before.values(), ...after.values()].some(hasDisplaySnapshot);

  return ids.map((memoryId) => {
    if (exact) {
      return {
        memoryId,
        ...(before.get(memoryId) ? { before: before.get(memoryId) } : {}),
        ...(after.get(memoryId) ? { after: after.get(memoryId) } : {}),
        accuracy: "exact"
      } satisfies MemoryMutationChange;
    }
    const current = entryById.get(memoryId);
    return {
      memoryId,
      ...(current ? { after: activitySnapshot(current) } : {}),
      accuracy: "current"
    } satisfies MemoryMutationChange;
  });
}

function hasDisplaySnapshot(snapshot: MemoryMutationEntrySnapshot): boolean {
  return typeof snapshot.statement === "string";
}

function activitySnapshot(entry: MemoryV2Entry): MemoryMutationEntrySnapshot {
  return {
    id: entry.frontmatter.id,
    scope: entry.frontmatter.scope,
    revision: entry.frontmatter.revision,
    statement: entry.statement,
    status: entry.frontmatter.status,
    semanticRole: entry.frontmatter.semantic_role,
    confidence: entry.frontmatter.confidence,
    facets: entry.frontmatter.facets,
    pinned: entry.frontmatter.pinned,
    activation: readActivation(entry.frontmatter),
    ...(entry.frontmatter.valid_from ? { validFrom: entry.frontmatter.valid_from } : {}),
    ...(entry.frontmatter.valid_to ? { validTo: entry.frontmatter.valid_to } : {}),
    supersedes: entry.frontmatter.supersedes,
    ...(entry.frontmatter.superseded_by ? { supersededBy: entry.frontmatter.superseded_by } : {})
  };
}

function readSchemaVersion(path: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown };
    return typeof parsed.version === "number" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function listBackupPaths(root: string): string[] {
  const parent = dirname(root);
  const prefix = `${basename(root)}.backup-`;
  try {
    return readdirSync(parent)
      .filter((name) => name.startsWith(prefix))
      .sort()
      .reverse()
      .slice(0, 5)
      .map((name) => join(parent, name));
  } catch {
    return [];
  }
}

function localOnnxStatusMessage(status: ReturnType<typeof getLocalOnnxMemoryEmbeddingStatus>["status"]): string {
  if (status === "ready") return "本地 ONNX 模型已加载，语义召回可直接使用。";
  if (status === "cached") return "本地 ONNX 模型已缓存，首次召回时会快速初始化。";
  if (status === "downloading") return "正在下载并初始化本地 ONNX 模型，首次使用可能需要一点时间。";
  if (status === "initializing") return "正在初始化本地 ONNX 模型。";
  if (status === "failed") return "本地 ONNX 模型初始化失败，当前会继续使用基础召回。";
  return "本地 ONNX 模型尚未缓存，点击“下载模型”即可开始下载。";
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
    tags: entry.frontmatter.tags,
    semanticRole: entry.frontmatter.semantic_role,
    facets: entry.frontmatter.facets,
    revision: entry.frontmatter.revision,
    lastConfirmedAt: entry.frontmatter.last_confirmed_at,
    evidenceRefs: entry.frontmatter.evidence_refs,
    supersedes: entry.frontmatter.supersedes,
    ...(entry.frontmatter.superseded_by ? { supersededBy: entry.frontmatter.superseded_by } : {}),
    ...(entry.frontmatter.valid_from ? { validFrom: entry.frontmatter.valid_from } : {}),
    ...(entry.frontmatter.valid_to ? { validTo: entry.frontmatter.valid_to } : {}),
    activation: readActivation(entry.frontmatter),
    ...(entry.frontmatter.claim ? { claim: entry.frontmatter.claim } : {})
  };
}

function pendingSummary(
  item: MemoryV2PendingItem,
  entryById: Map<string, MemoryV2Entry>
): MemorySettingsPendingSummary {
  const existingIds = item.frontmatter.existing?.ids ?? [];
  return {
    id: item.frontmatter.id,
    path: item.path,
    type: item.frontmatter.type,
    status: item.frontmatter.status,
    created: item.frontmatter.created,
    statement: item.frontmatter.candidate.statement,
    reason: item.frontmatter.reason,
    existingIds,
    candidate: {
      scope: item.frontmatter.candidate.targetScope,
      kind: fromV2Kind(item.frontmatter.candidate.kind),
      confidence: item.frontmatter.candidate.confidence ?? "medium",
      statement: item.frontmatter.candidate.statement,
      tags: item.frontmatter.candidate.tags ?? [],
      ...(item.frontmatter.candidate.claim ? { claim: item.frontmatter.candidate.claim } : {})
    },
    existingEntries: existingIds
      .map((id) => entryById.get(id))
      .filter((entry): entry is MemoryV2Entry => Boolean(entry))
      .map(entrySummary)
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
