import type {
  MemoryReadToolInput,
  MemoryReadToolResult,
  MemoryOrganizeHistoryInput,
  MemoryOrganizeHistoryResult,
  MemoryRememberToolInput,
  MemoryRuntimeConfig,
  MemorySettingsSnapshot,
  MemoryToolWriteResult,
  UpdateMemoryRuntimeConfigInput,
} from '@lume/shared'
import { MEMORY_IPC_CHANNELS } from '@lume/shared'
import { sidecarCall } from './system'

export const readMemory = (input: MemoryReadToolInput) =>
  sidecarCall<MemoryReadToolResult>(MEMORY_IPC_CHANNELS.READ, input)

export const rememberMemory = (input: MemoryRememberToolInput) =>
  sidecarCall<MemoryToolWriteResult>(MEMORY_IPC_CHANNELS.REMEMBER, input)

export const getMemorySettingsSnapshot = (workspaceSlug: string) =>
  sidecarCall<MemorySettingsSnapshot>(MEMORY_IPC_CHANNELS.SETTINGS_SNAPSHOT, { workspaceSlug })

export const organizeMemoryHistory = (input: MemoryOrganizeHistoryInput) =>
  sidecarCall<MemoryOrganizeHistoryResult>(MEMORY_IPC_CHANNELS.ORGANIZE_HISTORY, input)

export const openMemorySource = (input: { workspaceSlug: string; path: string }) =>
  sidecarCall<{ ok: true }>(MEMORY_IPC_CHANNELS.OPEN_SOURCE, input)

export const getMemoryRuntimeConfig = () =>
  sidecarCall<MemoryRuntimeConfig>(MEMORY_IPC_CHANNELS.GET_RUNTIME_CONFIG, {})

export const updateMemoryRuntimeConfig = (input: UpdateMemoryRuntimeConfigInput) =>
  sidecarCall<MemoryRuntimeConfig>(MEMORY_IPC_CHANNELS.UPDATE_RUNTIME_CONFIG, input)
