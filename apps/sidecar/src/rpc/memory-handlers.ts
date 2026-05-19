import { MEMORY_IPC_CHANNELS } from "@lume/shared";
import { createMemoryTools } from "../services/memory/memory-tools";
import {
  getMemoryRuntimeConfig,
  updateMemoryRuntimeConfig
} from "../services/memory/memory-policy";
import {
  memoryReadToolInputSchema,
  memoryRememberToolInputSchema,
  memorySearchInputSchema,
  updateMemoryRuntimeConfigInputSchema
} from "./schemas";
import type { RpcHandler } from "./types";
import { validateInput } from "./validation";

export function createMemoryHandlers(): Record<string, RpcHandler> {
  const tools = createMemoryTools();
  return {
    [MEMORY_IPC_CHANNELS.SEARCH]: async (params) => {
      return tools["memory.search"](
        validateInput(memorySearchInputSchema, params, MEMORY_IPC_CHANNELS.SEARCH)
      );
    },
    [MEMORY_IPC_CHANNELS.READ]: async (params) => {
      return tools["memory.read"](
        validateInput(memoryReadToolInputSchema, params, MEMORY_IPC_CHANNELS.READ)
      );
    },
    [MEMORY_IPC_CHANNELS.REMEMBER]: async (params) => {
      return tools["memory.remember"](
        validateInput(memoryRememberToolInputSchema, params, MEMORY_IPC_CHANNELS.REMEMBER)
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
