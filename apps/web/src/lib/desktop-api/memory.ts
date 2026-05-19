import type {
  MemoryReadToolInput,
  MemoryReadToolResult,
  MemoryRememberToolInput,
  MemoryRuntimeConfig,
  MemorySearchInput,
  MemorySearchResult,
  MemoryToolWriteResult,
  UpdateMemoryRuntimeConfigInput,
} from '@lume/shared'
import { MEMORY_IPC_CHANNELS } from '@lume/shared'
import { sidecarCall } from './system'

export const searchMemory = (input: MemorySearchInput) =>
  sidecarCall<MemorySearchResult[]>(MEMORY_IPC_CHANNELS.SEARCH, input)

export const readMemory = (input: MemoryReadToolInput) =>
  sidecarCall<MemoryReadToolResult>(MEMORY_IPC_CHANNELS.READ, input)

export const rememberMemory = (input: MemoryRememberToolInput) =>
  sidecarCall<MemoryToolWriteResult>(MEMORY_IPC_CHANNELS.REMEMBER, input)

export const getMemoryRuntimeConfig = () =>
  sidecarCall<MemoryRuntimeConfig>(MEMORY_IPC_CHANNELS.GET_RUNTIME_CONFIG, {})

export const updateMemoryRuntimeConfig = (input: UpdateMemoryRuntimeConfigInput) =>
  sidecarCall<MemoryRuntimeConfig>(MEMORY_IPC_CHANNELS.UPDATE_RUNTIME_CONFIG, input)
