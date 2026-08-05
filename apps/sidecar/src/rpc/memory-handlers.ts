import { randomUUID } from "node:crypto";
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
import { createLogger } from "../services/infra/logger";
import {
  readMemoryTool,
  rememberMemoryTool,
  searchMemoryTool
} from "../services/memory-v2/tools";
import { getMemoryV2SettingsSnapshot } from "../services/memory-v2/settings-snapshot";
import { getLocalOnnxMemoryEmbeddingStatus, retryLocalOnnxMemoryEmbedding } from "../services/memory-v2/local-embedding";
import { openMemoryV2Source } from "../services/memory-v2/source-open";
import { listMemorySourceFiles } from "../services/memory-v2/source-files";
import { organizeMemoryHistory } from "../services/memory-v2/history-organizer";
import { organizeMemoryEntries } from "../services/memory-v2/entry-organizer";
import { ingestExternalMemorySources } from "../services/memory-v2/ingestion";
import { createMemoryV2Store } from "../services/memory-v2/markdown-store";
import {
  getMemoryRuntimeConfig,
  updateMemoryRuntimeConfig
} from "../services/memory-v2/policy";
import type { MemoryV2Kind } from "../services/memory-v2/types";
import {
  memoryDeleteEntryInputSchema,
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
  memorySearchInputSchema,
  memoryUpdateEntryInputSchema,
  workspaceSlugInputSchema,
  updateMemoryRuntimeConfigInputSchema
} from "./schemas";
import type { RpcHandler } from "./types";
import { validateInput } from "./validation";

const log = createLogger("rpc.memory");

const ingestJobs = new Map<string, MemoryIngestSourcesJob>();
const organizeJobs = new Map<string, MemoryOrganizeJob>();

export function createMemoryHandlers(): Record<string, RpcHandler> {
  return {
    [MEMORY_IPC_CHANNELS.SEARCH]: async (params) => {
      return searchMemoryTool(
        validateInput(memorySearchInputSchema, params, MEMORY_IPC_CHANNELS.SEARCH)
      );
    },
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
    [MEMORY_IPC_CHANNELS.SETTINGS_SNAPSHOT]: async (params) => {
      const input = validateInput(workspaceSlugInputSchema, params, MEMORY_IPC_CHANNELS.SETTINGS_SNAPSHOT);
      return getMemoryV2SettingsSnapshot(input.workspaceSlug);
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
      const job = organizeJobs.get(input.jobId);
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
      const job = ingestJobs.get(input.jobId);
      if (!job) {
        throw new Error("记忆摄取任务不存在");
      }
      return job;
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

function updateMemoryEntryFromSettings(input: MemoryUpdateEntryInput): MemoryMutationResult {
  const entry = createMemoryV2Store().updateEntry({
    scope: input.scope,
    workspaceSlug: input.workspaceSlug,
    id: input.id,
    statement: input.statement,
    kind: toMemoryV2Kind(input.kind),
    confidence: input.confidence,
    tags: input.tags,
    ...(input.activation ? { activation: input.activation } : {})
  });
  return {
    ok: true,
    id: entry.frontmatter.id,
    path: entry.path
  };
}

function deleteMemoryEntryFromSettings(input: MemoryDeleteEntryInput): MemoryMutationResult {
  return createMemoryV2Store().deleteEntry({
    scope: input.scope,
    workspaceSlug: input.workspaceSlug,
    id: input.id
  });
}

function resolveMemoryPendingFromSettings(input: MemoryResolvePendingInput): MemoryMutationResult {
  return createMemoryV2Store().resolvePending({
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
  });
}

function startMemoryOrganizeHistoryJob(input: MemoryOrganizeHistoryInput): MemoryStartOrganizeJobResult {
  return startMemoryOrganizeJob("history", input.workspaceSlug, async (jobId) => {
    return organizeMemoryHistory({
      ...input,
      onProgress: (progress) => updateMemoryOrganizeJobProgress(jobId, progress)
    });
  });
}

function startMemoryOrganizeEntriesJob(input: MemoryOrganizeEntriesInput): MemoryStartOrganizeJobResult {
  return startMemoryOrganizeJob("entries", input.workspaceSlug, async (jobId) => {
    return organizeMemoryEntries({
      ...input,
      onProgress: (progress) => updateMemoryOrganizeJobProgress(jobId, progress)
    });
  });
}

function startMemoryOrganizeJob(
  kind: MemoryOrganizeJob["kind"],
  workspaceSlug: string,
  run: (jobId: string) => Promise<NonNullable<MemoryOrganizeJob["result"]>>
): MemoryStartOrganizeJobResult {
  const jobId = randomUUID();
  const startedAt = Date.now();
  organizeJobs.set(jobId, {
    jobId,
    kind,
    workspaceSlug,
    status: "running",
    startedAt
  });
  setTimeout(() => {
    void runMemoryOrganizeJob(jobId, run);
  }, 0);
  return {
    jobId,
    kind,
    workspaceSlug,
    status: "running",
    startedAt
  };
}

async function runMemoryOrganizeJob(
  jobId: string,
  run: (jobId: string) => Promise<NonNullable<MemoryOrganizeJob["result"]>>
): Promise<void> {
  const job = organizeJobs.get(jobId);
  if (!job) return;
  try {
    log.info("organize job started", { jobId, kind: job.kind, workspaceSlug: job.workspaceSlug });
    const result = await run(jobId);
    const current = organizeJobs.get(jobId) ?? job;
    organizeJobs.set(jobId, {
      ...current,
      status: "completed",
      completedAt: Date.now(),
      result
    });
    log.info("organize job completed", { jobId, kind: job.kind, workspaceSlug: job.workspaceSlug });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = organizeJobs.get(jobId) ?? job;
    organizeJobs.set(jobId, {
      ...current,
      status: "failed",
      completedAt: Date.now(),
      error: message
    });
    log.error("organize job failed", { jobId, kind: job.kind, workspaceSlug: job.workspaceSlug, error: message });
  }
}

function updateMemoryOrganizeJobProgress(
  jobId: string,
  progress: NonNullable<MemoryOrganizeJob["progress"]>
): void {
  const current = organizeJobs.get(jobId);
  if (!current || current.status !== "running") return;
  organizeJobs.set(jobId, {
    ...current,
    progress
  });
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
  const jobId = randomUUID();
  const startedAt = Date.now();
  ingestJobs.set(jobId, {
    jobId,
    workspaceSlug: input.workspaceSlug,
    status: "running",
    startedAt
  });
  setTimeout(() => {
    void runMemoryIngestJob(jobId, input);
  }, 0);
  return {
    jobId,
    workspaceSlug: input.workspaceSlug,
    status: "running",
    startedAt
  };
}

async function runMemoryIngestJob(jobId: string, input: MemoryIngestSourcesInput): Promise<void> {
  const job = ingestJobs.get(jobId);
  if (!job) return;
  try {
    log.info("ingest job started", { jobId, workspaceSlug: input.workspaceSlug, sourceCount: input.sources.length });
    const result = await ingestExternalMemorySources({
      ...input,
      onProgress: (progress) => {
        const current = ingestJobs.get(jobId);
        if (!current || current.status !== "running") return;
        ingestJobs.set(jobId, {
          ...current,
          progress
        });
      }
    });
    const current = ingestJobs.get(jobId) ?? job;
    ingestJobs.set(jobId, {
      ...current,
      status: "completed",
      completedAt: Date.now(),
      progress: {
        scannedSources: result.scannedSources,
        scannedChunks: result.scannedChunks,
        scannedBatches: result.scannedBatches,
        processedBatches: result.scannedBatches,
        candidateCount: result.candidateCount
      },
      result
    });
    log.info("ingest job completed", {
      jobId,
      workspaceSlug: input.workspaceSlug,
      scannedSources: result.scannedSources,
      candidateCount: result.candidateCount,
      actions: result.actions
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = ingestJobs.get(jobId) ?? job;
    ingestJobs.set(jobId, {
      ...current,
      status: "failed",
      completedAt: Date.now(),
      error: message
    });
    log.error("ingest job failed", { jobId, workspaceSlug: input.workspaceSlug, error: message });
  }
}
