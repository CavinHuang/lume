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
import { startMemorySyncWatcher } from "../services/memory/memory-sync-watcher";
import {
  memoryDistillInputSchema,
  memoryGetInputSchema,
  memoryIndexFileInputSchema,
  memoryIndexWorkspaceInputSchema,
  memorySaveInputSchema,
  memorySearchInputSchema,
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
    }
  };
}

export { closeMemoryManagers };
