import {
  MEMORY_IPC_CHANNELS,
  type MemoryDeleteEntryInput,
  type MemoryIngestSourcesInput,
  type MemoryIngestSourcesJob,
  type MemoryOrganizeEntriesInput,
  type MemoryOrganizeHistoryInput,
  type MemoryOrganizeJob,
  type MemoryKind,
  type MemoryMutationResult,
  type MemoryResolvePendingInput,
  type MemoryStartIngestSourcesResult,
  type MemoryStartOrganizeJobResult,
  type MemoryUpdateEntryInput
} from "@lume/shared";
import { readMemoryTool, rememberMemoryTool } from "../services/memory-v2/tools";
import {
  getMemoryV2DiagnosticsSnapshot,
  getMemoryV2SettingsSnapshot
} from "../services/memory-v2/settings-snapshot";
import { getLocalOnnxMemoryEmbeddingStatus, retryLocalOnnxMemoryEmbedding } from "../services/memory-v2/local-embedding";
import { openMemoryV2Source } from "../services/memory-v2/source-open";
import { listMemorySourceFiles } from "../services/memory-v2/source-files";
import { organizeMemoryHistory } from "../services/memory-v2/history-organizer";
import { ingestExternalMemorySources } from "../services/memory-v2/ingestion";
import { createMemoryV2Store } from "../services/memory-v2/markdown-store";
import { MemoryCommandService } from "../services/memory-v2/command-service";
import { claimFromEntry } from "../services/memory-v2/claim";
import { memoryJobService } from "../services/memory-v2/job-service";
import { enqueueConsolidation, maybeEnqueueAutoDream } from "../services/memory-v2/consolidation";
import { recoverMemoryJobsForWorkspace } from "../services/memory-v2/job-recovery";
import {
  getMemoryRuntimeConfig,
  updateMemoryRuntimeConfig
} from "../services/memory-v2/policy";
import type { MemoryV2Kind } from "../services/memory-v2/types";
import {
  memoryDeleteEntryInputSchema,
  memoryCancelJobInputSchema,
  memoryIngestSourcesInputSchema,
  memoryIngestSourcesJobInputSchema,
  memoryOrganizeEntriesInputSchema,
  memoryOrganizeJobInputSchema,
  memoryOrganizeHistoryInputSchema,
  memoryOpenSourceInputSchema,
  memoryListSourceFilesInputSchema,
  memoryReadToolInputSchema,
  memoryRememberToolInputSchema,
  memoryResolvePendingInputSchema,
  memoryUpdateEntryInputSchema,
  memoryUndoMutationInputSchema,
  workspaceSlugInputSchema,
  updateMemoryRuntimeConfigInputSchema
} from "./schemas";
import type { RpcHandler } from "./types";
import { validateInput } from "./validation";

export function createMemoryHandlers(): Record<string, RpcHandler> {
  return {
    [MEMORY_IPC_CHANNELS.READ]: async (params) => {
      return readMemoryTool(
        validateInput(memoryReadToolInputSchema, params, MEMORY_IPC_CHANNELS.READ)
      );
    },
    [MEMORY_IPC_CHANNELS.REMEMBER]: async (params) => {
      return rememberMemoryTool(
        validateInput(memoryRememberToolInputSchema, params, MEMORY_IPC_CHANNELS.REMEMBER)
      );
    },
    [MEMORY_IPC_CHANNELS.UNDO_MUTATION]: async (params) => {
      const input = validateInput(memoryUndoMutationInputSchema, params, MEMORY_IPC_CHANNELS.UNDO_MUTATION);
      return new MemoryCommandService().undo(input);
    },
    [MEMORY_IPC_CHANNELS.SETTINGS_SNAPSHOT]: async (params) => {
      const input = validateInput(workspaceSlugInputSchema, params, MEMORY_IPC_CHANNELS.SETTINGS_SNAPSHOT);
      recoverMemoryJobsForWorkspace(input.workspaceSlug);
      maybeEnqueueAutoDream(input.workspaceSlug);
      return getMemoryV2SettingsSnapshot(input.workspaceSlug);
    },
    [MEMORY_IPC_CHANNELS.DIAGNOSTICS_SNAPSHOT]: async (params) => {
      const input = validateInput(
        workspaceSlugInputSchema,
        params,
        MEMORY_IPC_CHANNELS.DIAGNOSTICS_SNAPSHOT
      );
      return getMemoryV2DiagnosticsSnapshot(input.workspaceSlug);
    },
    [MEMORY_IPC_CHANNELS.ORGANIZE_HISTORY]: async (params) => {
      return startMemoryOrganizeHistoryJob(
        validateInput(memoryOrganizeHistoryInputSchema, params, MEMORY_IPC_CHANNELS.ORGANIZE_HISTORY)
      );
    },
    [MEMORY_IPC_CHANNELS.ORGANIZE_ENTRIES]: async (params) => {
      return startMemoryOrganizeEntriesJob(
        validateInput(memoryOrganizeEntriesInputSchema, params, MEMORY_IPC_CHANNELS.ORGANIZE_ENTRIES)
      );
    },
    [MEMORY_IPC_CHANNELS.GET_ORGANIZE_JOB]: async (params) => {
      const input = validateInput(
        memoryOrganizeJobInputSchema,
        params,
        MEMORY_IPC_CHANNELS.GET_ORGANIZE_JOB
      );
      const workspaceSlug = input.workspaceSlug ?? memoryJobService.resolveWorkspace(input.jobId);
      if (!workspaceSlug) throw new Error("workspaceSlug is required");
      const job = memoryJobService.get<NonNullable<MemoryOrganizeJob["result"]>, NonNullable<MemoryOrganizeJob["progress"]>>(
        workspaceSlug,
        input.jobId
      );
      if (!job) {
        throw new Error("记忆整理任务不存在");
      }
      return job;
    },
    [MEMORY_IPC_CHANNELS.INGEST_SOURCES]: async (params) => {
      return startMemoryIngestJob(
        validateInput(memoryIngestSourcesInputSchema, params, MEMORY_IPC_CHANNELS.INGEST_SOURCES)
      );
    },
    [MEMORY_IPC_CHANNELS.GET_INGEST_JOB]: async (params) => {
      const input = validateInput(
        memoryIngestSourcesJobInputSchema,
        params,
        MEMORY_IPC_CHANNELS.GET_INGEST_JOB
      );
      const workspaceSlug = input.workspaceSlug ?? memoryJobService.resolveWorkspace(input.jobId);
      if (!workspaceSlug) throw new Error("workspaceSlug is required");
      const job = memoryJobService.get<NonNullable<MemoryIngestSourcesJob["result"]>, NonNullable<MemoryIngestSourcesJob["progress"]>>(
        workspaceSlug,
        input.jobId
      );
      if (!job) {
        throw new Error("记忆摄取任务不存在");
      }
      return job;
    },
    [MEMORY_IPC_CHANNELS.CANCEL_JOB]: async (params) => {
      const input = validateInput(memoryCancelJobInputSchema, params, MEMORY_IPC_CHANNELS.CANCEL_JOB);
      const job = memoryJobService.cancel(input.workspaceSlug, input.jobId);
      if (!job) throw new Error("记忆任务不存在");
      return job;
    },
    [MEMORY_IPC_CHANNELS.RETRY_JOB]: async (params) => {
      const input = validateInput(memoryCancelJobInputSchema, params, MEMORY_IPC_CHANNELS.RETRY_JOB);
      const job = memoryJobService.get(input.workspaceSlug, input.jobId);
      if (!job) {
        throw new Error("该记忆任务不可重试");
      }
      if (job.kind === "external_ingest" && job.payload) {
        return startMemoryIngestJob(job.payload as MemoryIngestSourcesInput);
      }
      if (job.kind === "consolidation") {
        const payload = job.payload && typeof job.payload === "object"
          ? job.payload as {
              manual?: boolean;
              context?: { threadId: string; runId: string; modelRef?: string };
              evidenceWindow?: import("../services/memory-v2/dream-evidence").DreamEvidenceWindow;
            }
          : undefined;
        const retried = enqueueConsolidation(input.workspaceSlug, payload?.manual ?? job.manual, payload?.context, {
          force: true,
          evidenceWindow: payload?.evidenceWindow
        });
        if (retried) return retried;
      }
      throw new Error("该记忆任务不可重试");
    },
    [MEMORY_IPC_CHANNELS.OPEN_SOURCE]: async (params) => {
      return openMemoryV2Source(
        validateInput(memoryOpenSourceInputSchema, params, MEMORY_IPC_CHANNELS.OPEN_SOURCE)
      );
    },
    [MEMORY_IPC_CHANNELS.LIST_SOURCE_FILES]: async (params) => {
      return listMemorySourceFiles(
        validateInput(memoryListSourceFilesInputSchema, params, MEMORY_IPC_CHANNELS.LIST_SOURCE_FILES)
      );
    },
    [MEMORY_IPC_CHANNELS.UPDATE_ENTRY]: async (params) => {
      return updateMemoryEntryFromSettings(
        validateInput(memoryUpdateEntryInputSchema, params, MEMORY_IPC_CHANNELS.UPDATE_ENTRY)
      );
    },
    [MEMORY_IPC_CHANNELS.DELETE_ENTRY]: async (params) => {
      return deleteMemoryEntryFromSettings(
        validateInput(memoryDeleteEntryInputSchema, params, MEMORY_IPC_CHANNELS.DELETE_ENTRY)
      );
    },
    [MEMORY_IPC_CHANNELS.RESOLVE_PENDING]: async (params) => {
      return resolveMemoryPendingFromSettings(
        validateInput(memoryResolvePendingInputSchema, params, MEMORY_IPC_CHANNELS.RESOLVE_PENDING)
      );
    },
    [MEMORY_IPC_CHANNELS.GET_RUNTIME_CONFIG]: async () => {
      return getMemoryRuntimeConfig();
    },
    [MEMORY_IPC_CHANNELS.UPDATE_RUNTIME_CONFIG]: async (params) => {
      return updateMemoryRuntimeConfig(
        validateInput(updateMemoryRuntimeConfigInputSchema, params, MEMORY_IPC_CHANNELS.UPDATE_RUNTIME_CONFIG)
      );
    },
    [MEMORY_IPC_CHANNELS.RELOAD_LOCAL_ONNX]: async () => {
      retryLocalOnnxMemoryEmbedding();
      return getLocalOnnxMemoryEmbeddingStatus();
    }
  };
}

async function updateMemoryEntryFromSettings(input: MemoryUpdateEntryInput): Promise<MemoryMutationResult> {
  const commands = new MemoryCommandService();
  if (input.targetScope && input.targetScope !== input.scope) {
    commands.moveScope({
      workspaceSlug: input.workspaceSlug,
      id: input.id,
      scope: input.scope,
      targetScope: input.targetScope
    });
  }
  const scope = input.targetScope ?? input.scope;
  if (input.explicitCorrection && input.statement) {
    const existing = createMemoryV2Store().listEntries({
      workspaceSlug: input.workspaceSlug,
      scopes: [scope],
      includeStatuses: ["active", "suspected_stale"]
    }).find((item) => item.frontmatter.id === input.id);
    const receipt = await commands.remember({
      workspaceSlug: input.workspaceSlug,
      content: input.statement,
      scope,
      claim: existing ? claimFromEntry(existing) : undefined,
      confidence: input.confidence,
      facets: input.tags,
      actor: "user",
      explicitCorrection: true
    });
    return {
      ok: true,
      id: receipt.memoryIds[0] ?? input.id,
      path: input.id,
      mutationId: receipt.mutationId,
      summary: receipt.summary,
      undoable: receipt.undoable
    };
  }
  const receipt = commands.update({
    scope,
    workspaceSlug: input.workspaceSlug,
    id: input.id,
    statement: input.statement,
    kind: toMemoryV2Kind(input.kind),
    confidence: input.confidence,
    facets: input.tags,
    ...(input.activation ? { activation: input.activation } : {}),
    ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
    ...(input.validTo !== undefined ? { validTo: input.validTo } : {}),
    actor: "user"
  });
  const entry = createMemoryV2Store().listEntries({
    workspaceSlug: input.workspaceSlug,
    scopes: [scope],
    includeStatuses: ["active", "suspected_stale", "archived", "superseded"]
  }).find((item) => item.frontmatter.id === input.id);
  return {
    ok: true,
    id: receipt.memoryIds[0] ?? input.id,
    path: entry?.path ?? input.id,
    mutationId: receipt.mutationId,
    summary: receipt.summary,
    undoable: receipt.undoable
  };
}

function deleteMemoryEntryFromSettings(input: MemoryDeleteEntryInput): MemoryMutationResult {
  const receipt = new MemoryCommandService().archive({
    scope: input.scope,
    workspaceSlug: input.workspaceSlug,
    id: input.id,
    actor: "user"
  });
  const entry = createMemoryV2Store().listEntries({
    workspaceSlug: input.workspaceSlug,
    scopes: [input.scope],
    includeStatuses: ["archived"]
  }).find((item) => item.frontmatter.id === input.id);
  return {
    ok: true,
    id: receipt.memoryIds[0] ?? input.id,
    path: entry?.path ?? input.id,
    mutationId: receipt.mutationId,
    summary: receipt.summary,
    undoable: receipt.undoable
  };
}

function resolveMemoryPendingFromSettings(input: MemoryResolvePendingInput): MemoryMutationResult {
  return new MemoryCommandService().resolvePending({
    workspaceSlug: input.workspaceSlug,
    path: input.path,
    action: input.action,
    candidateOverride: input.candidateOverride
      ? {
          statement: input.candidateOverride.statement,
          kind: toMemoryV2Kind(input.candidateOverride.kind),
          confidence: input.candidateOverride.confidence,
          tags: input.candidateOverride.tags
        }
      : undefined
  }).result;
}

function startMemoryOrganizeHistoryJob(input: MemoryOrganizeHistoryInput): MemoryStartOrganizeJobResult {
  return startMemoryOrganizeJob("history", input.workspaceSlug, async (report) => {
    return organizeMemoryHistory({
      ...input,
      onProgress: report
    });
  });
}

function startMemoryOrganizeEntriesJob(input: MemoryOrganizeEntriesInput): MemoryStartOrganizeJobResult {
  const job = enqueueConsolidation(input.workspaceSlug, true);
  if (!job) throw new Error("无法启动记忆整理任务");
  return {
    jobId: job.jobId,
    kind: "consolidation",
    workspaceSlug: input.workspaceSlug,
    status: "running",
    startedAt: job.startedAt ?? job.createdAt
  };
}

function startMemoryOrganizeJob(
  kind: MemoryOrganizeJob["kind"],
  workspaceSlug: string,
  run: (
    report: (progress: NonNullable<MemoryOrganizeJob["progress"]>) => void,
    signal: AbortSignal
  ) => Promise<NonNullable<MemoryOrganizeJob["result"]>>
): MemoryStartOrganizeJobResult {
  const job = memoryJobService.start({
    kind,
    workspaceSlug,
    manual: true,
    run: ({ report, signal }) => run(report, signal)
  });
  return {
    jobId: job.jobId,
    kind,
    workspaceSlug,
    status: "running",
    startedAt: job.startedAt ?? job.createdAt
  };
}

function toMemoryV2Kind(kind?: MemoryKind): MemoryV2Kind | undefined {
  if (!kind) return undefined;
  if (kind === "preference" || kind === "fact" || kind === "decision" || kind === "lesson") {
    return kind;
  }
  if (kind === "summary" || kind === "episode" || kind === "milestone") {
    return "state";
  }
  throw new Error("不支持的记忆类型");
}

function startMemoryIngestJob(input: MemoryIngestSourcesInput): MemoryStartIngestSourcesResult {
  const job = memoryJobService.start({
    kind: "external_ingest",
    workspaceSlug: input.workspaceSlug,
    manual: true,
    payload: input,
    run: ({ report, signal }) => ingestExternalMemorySources({
      ...input,
      onProgress: report,
      signal
    })
  });
  return {
    jobId: job.jobId,
    workspaceSlug: input.workspaceSlug,
    status: "running",
    startedAt: job.startedAt ?? job.createdAt
  };
}
