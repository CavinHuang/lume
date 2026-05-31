import type {
  MemoryReadToolInput,
  MemoryReadToolResult,
  MemoryDeleteEntryInput,
  MemoryIngestSourcesInput,
  MemoryIngestSourcesJob,
  MemoryIngestSourcesJobInput,
  MemoryMutationResult,
  MemoryStartIngestSourcesResult,
  MemoryOrganizeEntriesInput,
  MemoryOrganizeEntriesResult,
  MemoryOrganizeHistoryInput,
  MemoryOrganizeHistoryResult,
  MemoryRememberToolInput,
  MemoryResolvePendingInput,
  MemoryRuntimeConfig,
  MemorySettingsSnapshot,
  MemoryToolWriteResult,
  MemoryUpdateEntryInput,
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

export const organizeMemoryEntries = (input: MemoryOrganizeEntriesInput) =>
  sidecarCall<MemoryOrganizeEntriesResult>(MEMORY_IPC_CHANNELS.ORGANIZE_ENTRIES, input)

export const ingestMemorySources = (input: MemoryIngestSourcesInput) =>
  sidecarCall<MemoryStartIngestSourcesResult>(MEMORY_IPC_CHANNELS.INGEST_SOURCES, input)

export const getMemoryIngestJob = (input: MemoryIngestSourcesJobInput) =>
  sidecarCall<MemoryIngestSourcesJob>(MEMORY_IPC_CHANNELS.GET_INGEST_JOB, input)

export const openMemorySource = (input: { workspaceSlug: string; path: string }) =>
  sidecarCall<{ ok: true }>(MEMORY_IPC_CHANNELS.OPEN_SOURCE, input)

export const updateMemoryEntry = (input: MemoryUpdateEntryInput) =>
  sidecarCall<MemoryMutationResult>(MEMORY_IPC_CHANNELS.UPDATE_ENTRY, input)

export const deleteMemoryEntry = (input: MemoryDeleteEntryInput) =>
  sidecarCall<MemoryMutationResult>(MEMORY_IPC_CHANNELS.DELETE_ENTRY, input)

export const resolveMemoryPending = (input: MemoryResolvePendingInput) =>
  sidecarCall<MemoryMutationResult>(MEMORY_IPC_CHANNELS.RESOLVE_PENDING, input)

export const getMemoryRuntimeConfig = () =>
  sidecarCall<MemoryRuntimeConfig>(MEMORY_IPC_CHANNELS.GET_RUNTIME_CONFIG, {})

export const updateMemoryRuntimeConfig = (input: UpdateMemoryRuntimeConfigInput) =>
  sidecarCall<MemoryRuntimeConfig>(MEMORY_IPC_CHANNELS.UPDATE_RUNTIME_CONFIG, input)
