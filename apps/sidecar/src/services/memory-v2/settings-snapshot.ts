import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  MemoryKind,
  MemoryDreamResult,
  MemoryIngestSourcesResult,
  MemoryJobKind,
  MemoryMutationChange,
  MemoryMutationEntrySnapshot,
  MemoryOrganizeEntriesResult,
  MemoryOrganizeHistoryResult,
  MemoryPendingCounts,
  MemorySettingsActivityItem,
  MemorySettingsEntrySummary,
  MemorySettingsFileSummary,
  MemorySettingsJobProgress,
  MemorySettingsJobResult,
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
    jobs: memoryJobService.list(workspaceSlug).map((job) => ({
      jobId: job.jobId,
      kind: job.kind,
      status: job.status,
      createdAt: job.createdAt,
      retryable: (job.kind === "external_ingest" || job.kind === "consolidation")
        && (job.status === "failed" || job.status === "cancelled" || job.status === "interrupted")
        && (job.kind === "consolidation" || job.payload !== undefined),
      ...(job.startedAt ? { startedAt: job.startedAt } : {}),
      ...(job.completedAt ? { completedAt: job.completedAt } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.progress !== undefined || job.result !== undefined
        ? { progress: settingsJobProgress(job.kind, job.progress, job.result) }
        : {}),
      ...(job.result !== undefined ? { result: settingsJobResult(job.kind, job.result) } : {})
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

function settingsJobProgress(
  kind: MemoryJobKind,
  progress: unknown,
  result: unknown
): MemorySettingsJobProgress {
  const value = asRecord(progress);
  const output = asRecord(result);
  const changedFiles = Array.isArray(value.changedFiles)
    ? value.changedFiles.filter((item): item is string => typeof item === "string")
    : kind === "consolidation" && Array.isArray(output.rebuilt)
      ? output.rebuilt.filter((item): item is string => typeof item === "string")
      : [];
  const scannedItems = readNumber(value.scannedItems)
    ?? readNumber(value.scannedSources)
    ?? readNumber(value.scannedChunks)
    ?? readNumber(value.scannedBatches);
  const processedItems = readNumber(value.processedItems) ?? readNumber(value.processedBatches);
  const changedItems = readNumber(value.changedItems);
  const candidateCount = readNumber(value.candidateCount);
  const reviewedSessions = readNumber(value.reviewedSessions);
  const reviewedEvidence = readNumber(value.reviewedEvidence);
  const proposedActions = readNumber(value.proposedActions);
  return {
    phase: readString(value.phase) ?? readString(value.label) ?? completedJobPhase(kind, result),
    ...(scannedItems !== undefined ? { scannedItems } : {}),
    ...(processedItems !== undefined ? { processedItems } : {}),
    ...(reviewedSessions !== undefined ? { reviewedSessions } : {}),
    ...(reviewedEvidence !== undefined ? { reviewedEvidence } : {}),
    ...(proposedActions !== undefined ? { proposedActions } : {}),
    ...(changedItems !== undefined ? { changedItems } : {}),
    ...(candidateCount !== undefined ? { candidateCount } : {}),
    changedFiles
  };
}

function completedJobPhase(kind: MemoryJobKind, result: unknown): string {
  if (result !== undefined) return "任务已完成";
  if (kind === "turn_extract") return "准备提取对话记忆";
  if (kind === "consolidation") return "准备整理记忆";
  return "准备后台任务";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function settingsJobResult(kind: MemoryJobKind, result: unknown): MemorySettingsJobResult {
  switch (kind) {
    case "history":
      return { kind, data: result as MemoryOrganizeHistoryResult };
    case "entries":
      return { kind, data: result as MemoryOrganizeEntriesResult };
    case "external_ingest":
      return { kind, data: result as MemoryIngestSourcesResult };
    case "turn_extract":
      return { kind, data: result as { scannedItems: number; changedItems: number } };
    case "consolidation":
      return { kind, data: normalizeDreamResult(result) };
  }
}

function normalizeDreamResult(result: unknown): MemoryDreamResult {
  const value = asRecord(result);
  const actions = asRecord(value.actions);
  const legacyUpdated = readNumber(value.updated) ?? 0;
  const legacyMerged = readNumber(value.merged) ?? 0;
  const legacyStale = readNumber(value.stale) ?? 0;
  return {
    sessionsReviewed: readNumber(value.sessionsReviewed) ?? 0,
    evidenceItemsReviewed: readNumber(value.evidenceItemsReviewed) ?? 0,
    scannedEntries: readNumber(value.scannedEntries) ?? 0,
    actions: {
      created: readNumber(actions.created) ?? 0,
      versioned: readNumber(actions.versioned) ?? 0,
      updated: readNumber(actions.updated) ?? legacyUpdated,
      merged: readNumber(actions.merged) ?? legacyMerged,
      stale: readNumber(actions.stale) ?? legacyStale,
      pending: readNumber(actions.pending) ?? 0,
      ignored: readNumber(actions.ignored) ?? 0
    },
    items: Array.isArray(value.items) ? value.items as MemoryDreamResult["items"] : [],
    rebuilt: Array.isArray(value.rebuilt)
      ? value.rebuilt.filter((item): item is string => typeof item === "string")
      : [],
    warnings: Array.isArray(value.warnings)
      ? value.warnings.filter((item): item is string => typeof item === "string")
      : []
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
            if (parsed.receipt && !["ignored", "duplicate"].includes(parsed.receipt.action)) {
              const receipt = {
                ...parsed.receipt,
                summary: parsed.receipt.summary || fallbackActivitySummary(parsed.receipt.action)
              };
              activity.push({
                ...receipt,
                changes: buildMutationChanges({ ...parsed, receipt }, entryById)
              });
            }
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

function fallbackActivitySummary(action: MemoryMutationReceipt["action"]): string {
  const summaries: Partial<Record<MemoryMutationReceipt["action"], string>> = {
    created: "已记住新的信息",
    updated: "更新了记忆",
    superseded: "用新版本替换了旧记忆",
    merged: "合并了重复记忆",
    archived: "归档了记忆",
    pending: "产生待处理记忆，等待确认"
  };
  return summaries[action] ?? "记忆操作已完成";
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
