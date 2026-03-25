import { MEMORY_IPC_CHANNELS } from "@lume/shared";
import {
  closeMemoryManagers,
  getWorkspaceMemoryFile,
  getWorkspaceMemoryStats,
  getWorkspaceMemoryStatus,
  indexWorkspaceMemory,
  indexWorkspaceMemoryFile,
  saveWorkspaceMemory,
  searchWorkspaceMemory
} from "../services/memory/memory-service";
import {
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
    [MEMORY_IPC_CHANNELS.INDEX_WORKSPACE]: async (params) =>
      indexWorkspaceMemory(
        validateInput(memoryIndexWorkspaceInputSchema, params, MEMORY_IPC_CHANNELS.INDEX_WORKSPACE)
      ),
    [MEMORY_IPC_CHANNELS.INDEX_FILE]: async (params) =>
      indexWorkspaceMemoryFile(
        validateInput(memoryIndexFileInputSchema, params, MEMORY_IPC_CHANNELS.INDEX_FILE)
      ),
    [MEMORY_IPC_CHANNELS.SEARCH]: async (params) =>
      searchWorkspaceMemory(validateInput(memorySearchInputSchema, params, MEMORY_IPC_CHANNELS.SEARCH)),
    [MEMORY_IPC_CHANNELS.STATS]: async (params) => {
      const input = validateInput(workspaceSlugInputSchema, params, MEMORY_IPC_CHANNELS.STATS);
      return getWorkspaceMemoryStats(input.workspaceSlug);
    },
    [MEMORY_IPC_CHANNELS.GET]: async (params) =>
      getWorkspaceMemoryFile(validateInput(memoryGetInputSchema, params, MEMORY_IPC_CHANNELS.GET)),
    [MEMORY_IPC_CHANNELS.SAVE]: async (params) =>
      saveWorkspaceMemory(validateInput(memorySaveInputSchema, params, MEMORY_IPC_CHANNELS.SAVE)),
    [MEMORY_IPC_CHANNELS.STATUS]: async (params) => {
      const input = validateInput(workspaceSlugInputSchema, params, MEMORY_IPC_CHANNELS.STATUS);
      return getWorkspaceMemoryStatus(input.workspaceSlug);
    }
  };
}

export { closeMemoryManagers };
