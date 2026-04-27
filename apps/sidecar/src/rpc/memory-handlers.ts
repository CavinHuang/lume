import { MEMORY_IPC_CHANNELS } from "@lume/shared";
import {
  closeMemoryManagers,
  getLayeredMemoryStats,
  getLayeredMemoryStatus,
  indexWorkspaceMemoryCorpus,
  indexWorkspaceMemoryDocument,
  readLayeredMemoryFile,
  runWorkspaceMemoryDistillation,
  searchLayeredMemory,
  writeWorkspaceMemory
} from "../services/memory/memory-service";
import {
  getGlobalMemoryStatus,
  listGlobalMemoryCandidates,
  promoteGlobalMemory,
  rejectGlobalMemoryCandidate,
  searchGlobalMemory
} from "../services/memory/memory-global-promoter";
import { startMemorySyncWatcher } from "../services/memory/memory-sync-watcher";
import {
  listGlobalMemoryCandidatesInputSchema,
  memoryDistillInputSchema,
  memoryGetInputSchema,
  memoryIndexFileInputSchema,
  memoryIndexWorkspaceInputSchema,
  promoteGlobalMemoryInputSchema,
  rejectGlobalMemoryCandidateInputSchema,
  memorySaveInputSchema,
  memorySearchInputSchema,
  searchGlobalMemoryInputSchema,
  workspaceSlugInputSchema
} from "./schemas";
import type { RpcHandler } from "./types";
import { validateInput } from "./validation";

export function createMemoryHandlers(): Record<string, RpcHandler> {
  return {
    [MEMORY_IPC_CHANNELS.INDEX_CORPUS]: async (params) => {
      startMemorySyncWatcher();
      return indexWorkspaceMemoryCorpus(
        validateInput(memoryIndexWorkspaceInputSchema, params, MEMORY_IPC_CHANNELS.INDEX_CORPUS)
      );
    },
    [MEMORY_IPC_CHANNELS.INDEX_DOCUMENT]: async (params) => {
      startMemorySyncWatcher();
      return indexWorkspaceMemoryDocument(
        validateInput(memoryIndexFileInputSchema, params, MEMORY_IPC_CHANNELS.INDEX_DOCUMENT)
      );
    },
    [MEMORY_IPC_CHANNELS.SEARCH_LAYERED]: async (params) => {
      startMemorySyncWatcher();
      return searchLayeredMemory(validateInput(memorySearchInputSchema, params, MEMORY_IPC_CHANNELS.SEARCH_LAYERED));
    },
    [MEMORY_IPC_CHANNELS.STATS_LAYERED]: async (params) => {
      startMemorySyncWatcher();
      const input = validateInput(workspaceSlugInputSchema, params, MEMORY_IPC_CHANNELS.STATS_LAYERED);
      return getLayeredMemoryStats(input.workspaceSlug);
    },
    [MEMORY_IPC_CHANNELS.READ_LAYERED]: async (params) => {
      startMemorySyncWatcher();
      return readLayeredMemoryFile(validateInput(memoryGetInputSchema, params, MEMORY_IPC_CHANNELS.READ_LAYERED));
    },
    [MEMORY_IPC_CHANNELS.WRITE_WORKSPACE]: async (params) => {
      startMemorySyncWatcher();
      return writeWorkspaceMemory(validateInput(memorySaveInputSchema, params, MEMORY_IPC_CHANNELS.WRITE_WORKSPACE));
    },
    [MEMORY_IPC_CHANNELS.DISTILL_WORKSPACE]: async (params) => {
      startMemorySyncWatcher();
      return runWorkspaceMemoryDistillation(
        validateInput(memoryDistillInputSchema, params, MEMORY_IPC_CHANNELS.DISTILL_WORKSPACE)
      );
    },
    [MEMORY_IPC_CHANNELS.STATUS_LAYERED]: async (params) => {
      startMemorySyncWatcher();
      const input = validateInput(workspaceSlugInputSchema, params, MEMORY_IPC_CHANNELS.STATUS_LAYERED);
      return getLayeredMemoryStatus(input.workspaceSlug);
    },
    [MEMORY_IPC_CHANNELS.LIST_GLOBAL_CANDIDATES]: async (params) => {
      const input = validateInput(
        listGlobalMemoryCandidatesInputSchema,
        params,
        MEMORY_IPC_CHANNELS.LIST_GLOBAL_CANDIDATES
      ) ?? {};
      return listGlobalMemoryCandidates(input);
    },
    [MEMORY_IPC_CHANNELS.PROMOTE_GLOBAL]: async (params) => {
      return promoteGlobalMemory(
        validateInput(promoteGlobalMemoryInputSchema, params, MEMORY_IPC_CHANNELS.PROMOTE_GLOBAL)
      );
    },
    [MEMORY_IPC_CHANNELS.REJECT_GLOBAL_CANDIDATE]: async (params) => {
      const input = validateInput(
        rejectGlobalMemoryCandidateInputSchema,
        params,
        MEMORY_IPC_CHANNELS.REJECT_GLOBAL_CANDIDATE
      );
      return rejectGlobalMemoryCandidate(input.candidateId);
    },
    [MEMORY_IPC_CHANNELS.SEARCH_GLOBAL]: async (params) => {
      return searchGlobalMemory(
        validateInput(searchGlobalMemoryInputSchema, params, MEMORY_IPC_CHANNELS.SEARCH_GLOBAL)
      );
    },
    [MEMORY_IPC_CHANNELS.STATUS_GLOBAL]: async () => {
      return getGlobalMemoryStatus();
    }
  };
}

export { closeMemoryManagers };
