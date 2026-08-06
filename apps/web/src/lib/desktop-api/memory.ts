import type {
  MemoryReadToolInput,
  MemoryReadToolResult,
  MemoryDeleteEntryInput,
  MemoryIngestSourcesInput,
  MemoryIngestSourcesJob,
  MemoryIngestSourcesJobInput,
  MemoryMutationResult,
  MemoryOrganizeJob,
  MemoryOrganizeJobInput,
  MemoryStartIngestSourcesResult,
  MemoryStartOrganizeJobResult,
  MemoryOrganizeHistoryInput,
  MemoryOrganizeEntriesInput,
  MemoryRememberToolInput,
  MemoryResolvePendingInput,
  MemoryRuntimeConfig,
  MemorySettingsSnapshot,
  MemoryDiagnosticsSnapshot,
  MemoryToolWriteResult,
  MemoryUpdateEntryInput,
  FileRef,
  MemoryListSourceFilesInput,
  MemorySourceFilesPage,
  UpdateMemoryRuntimeConfigInput,
  MemoryUndoMutationInput,
  MemoryMutationReceipt,
  MemoryCancelJobInput,
  MemoryJobStatus,
} from '@lume/shared'
import { MEMORY_IPC_CHANNELS } from '@lume/shared'
import { sidecarCall } from './system'
import { openFileRefInSystem } from './native'

export const readMemory = (input: MemoryReadToolInput) =>
  sidecarCall<MemoryReadToolResult>(MEMORY_IPC_CHANNELS.READ, input)

export const rememberMemory = (input: MemoryRememberToolInput) =>
  sidecarCall<MemoryToolWriteResult>(MEMORY_IPC_CHANNELS.REMEMBER, input)

export const undoMemoryMutation = (input: MemoryUndoMutationInput) =>
  sidecarCall<MemoryMutationReceipt>(MEMORY_IPC_CHANNELS.UNDO_MUTATION, input)

export const getMemorySettingsSnapshot = (workspaceSlug: string) =>
  sidecarCall<MemorySettingsSnapshot>(MEMORY_IPC_CHANNELS.SETTINGS_SNAPSHOT, { workspaceSlug })

export const getMemoryDiagnosticsSnapshot = (workspaceSlug: string) =>
  sidecarCall<MemoryDiagnosticsSnapshot>(MEMORY_IPC_CHANNELS.DIAGNOSTICS_SNAPSHOT, { workspaceSlug })

export const organizeMemoryHistory = (input: MemoryOrganizeHistoryInput) =>
  sidecarCall<MemoryStartOrganizeJobResult>(MEMORY_IPC_CHANNELS.ORGANIZE_HISTORY, input)

export const organizeMemoryEntries = (input: MemoryOrganizeEntriesInput) =>
  sidecarCall<MemoryStartOrganizeJobResult>(MEMORY_IPC_CHANNELS.ORGANIZE_ENTRIES, input)

export const getMemoryOrganizeJob = (input: MemoryOrganizeJobInput) =>
  sidecarCall<MemoryOrganizeJob>(MEMORY_IPC_CHANNELS.GET_ORGANIZE_JOB, input)

export const ingestMemorySources = (input: MemoryIngestSourcesInput) =>
  sidecarCall<MemoryStartIngestSourcesResult>(MEMORY_IPC_CHANNELS.INGEST_SOURCES, input)

export const getMemoryIngestJob = (input: MemoryIngestSourcesJobInput) =>
  sidecarCall<MemoryIngestSourcesJob>(MEMORY_IPC_CHANNELS.GET_INGEST_JOB, input)

export const cancelMemoryJob = (input: MemoryCancelJobInput) =>
  sidecarCall<{ status: MemoryJobStatus }>(MEMORY_IPC_CHANNELS.CANCEL_JOB, input)

export const retryMemoryJob = (input: MemoryCancelJobInput) =>
  sidecarCall<MemoryStartIngestSourcesResult>(MEMORY_IPC_CHANNELS.RETRY_JOB, input)

export const listMemorySourceFiles = (input: MemoryListSourceFilesInput) =>
  sidecarCall<MemorySourceFilesPage>(MEMORY_IPC_CHANNELS.LIST_SOURCE_FILES, input)

export const openMemorySource = async (input: { workspaceSlug: string; path: string }) => {
  const result = await sidecarCall<{ ok: true; ref: FileRef }>(MEMORY_IPC_CHANNELS.OPEN_SOURCE, input)
  await openFileRefInSystem(result.ref)
}

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

export const reloadLocalOnnxEmbedding = () =>
  sidecarCall(MEMORY_IPC_CHANNELS.RELOAD_LOCAL_ONNX, {})
