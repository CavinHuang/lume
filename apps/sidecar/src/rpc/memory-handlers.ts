import { randomUUID } from "node:crypto";
import {
  MEMORY_IPC_CHANNELS,
  type MemoryIngestSourcesInput,
  type MemoryIngestSourcesJob,
  type MemoryStartIngestSourcesResult
} from "@lume/shared";
import {
  readMemoryTool,
  rememberMemoryTool,
  searchMemoryTool
} from "../services/memory-v2/tools";
import { getMemoryV2SettingsSnapshot } from "../services/memory-v2/settings-snapshot";
import { openMemoryV2Source } from "../services/memory-v2/source-open";
import { organizeMemoryHistory } from "../services/memory-v2/history-organizer";
import { organizeMemoryEntries } from "../services/memory-v2/entry-organizer";
import { ingestExternalMemorySources } from "../services/memory-v2/ingestion";
import {
  getMemoryRuntimeConfig,
  updateMemoryRuntimeConfig
} from "../services/memory-v2/policy";
import {
  memoryIngestSourcesInputSchema,
  memoryIngestSourcesJobInputSchema,
  memoryOrganizeEntriesInputSchema,
  memoryOrganizeHistoryInputSchema,
  memoryOpenSourceInputSchema,
  memoryReadToolInputSchema,
  memoryRememberToolInputSchema,
  memorySearchInputSchema,
  workspaceSlugInputSchema,
  updateMemoryRuntimeConfigInputSchema
} from "./schemas";
import type { RpcHandler } from "./types";
import { validateInput } from "./validation";

const ingestJobs = new Map<string, MemoryIngestSourcesJob>();

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
      return organizeMemoryHistory(
        validateInput(memoryOrganizeHistoryInputSchema, params, MEMORY_IPC_CHANNELS.ORGANIZE_HISTORY)
      );
    },
    [MEMORY_IPC_CHANNELS.ORGANIZE_ENTRIES]: async (params) => {
      return organizeMemoryEntries(
        validateInput(memoryOrganizeEntriesInputSchema, params, MEMORY_IPC_CHANNELS.ORGANIZE_ENTRIES)
      );
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
    [MEMORY_IPC_CHANNELS.GET_RUNTIME_CONFIG]: async () => {
      return getMemoryRuntimeConfig();
    },
    [MEMORY_IPC_CHANNELS.UPDATE_RUNTIME_CONFIG]: async (params) => {
      return updateMemoryRuntimeConfig(
        validateInput(updateMemoryRuntimeConfigInputSchema, params, MEMORY_IPC_CHANNELS.UPDATE_RUNTIME_CONFIG)
      );
    }
  };
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
    const result = await ingestExternalMemorySources(input);
    ingestJobs.set(jobId, {
      ...job,
      status: "completed",
      completedAt: Date.now(),
      result
    });
  } catch (error) {
    ingestJobs.set(jobId, {
      ...job,
      status: "failed",
      completedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
