import type {
  GlobalMemoryCandidate,
  GlobalMemoryStatus,
  MemoryDistillationResult,
  MemoryGetInput,
  MemoryGetResult,
  MemoryIndexFileInput,
  MemoryIndexWorkspaceInput,
  MemoryItem,
  MemoryProviderStatus,
  MemoryRuntimeConfig,
  MemorySearchInput,
  MemorySearchResult,
  MemoryStats,
  PromoteGlobalMemoryInput,
  UpdateMemoryRuntimeConfigInput,
} from '@lume/shared'
import { MEMORY_IPC_CHANNELS } from '@lume/shared'
import { sidecarCall } from './system'

export const getMemoryStatus = (workspaceSlug: string) =>
  sidecarCall<MemoryProviderStatus>(MEMORY_IPC_CHANNELS.STATUS_LAYERED, { workspaceSlug })

export const getMemoryStats = (workspaceSlug: string) =>
  sidecarCall<MemoryStats>(MEMORY_IPC_CHANNELS.STATS_LAYERED, { workspaceSlug })

export const indexMemoryWorkspace = (input: MemoryIndexWorkspaceInput) =>
  sidecarCall<{ indexedChunks: number }>(MEMORY_IPC_CHANNELS.INDEX_CORPUS, input)

export const indexMemoryDocument = (input: MemoryIndexFileInput) =>
  sidecarCall<{ indexedChunks: number }>(MEMORY_IPC_CHANNELS.INDEX_DOCUMENT, input)

export const searchMemory = (input: MemorySearchInput) =>
  sidecarCall<MemorySearchResult[]>(MEMORY_IPC_CHANNELS.SEARCH_LAYERED, input)

export const readMemory = (input: MemoryGetInput) =>
  sidecarCall<MemoryGetResult>(MEMORY_IPC_CHANNELS.READ_LAYERED, input)

export const distillWorkspaceMemory = (input: {
  workspaceSlug: string
  days?: number
  dryRun?: boolean
  updateWorkspaceBrief?: boolean
  generateGlobalCandidates?: boolean
}) => sidecarCall<MemoryDistillationResult>(MEMORY_IPC_CHANNELS.DISTILL_WORKSPACE, input)

export const getGlobalMemoryStatus = () =>
  sidecarCall<GlobalMemoryStatus>(MEMORY_IPC_CHANNELS.STATUS_GLOBAL, {})

export const listGlobalMemoryCandidates = (status?: GlobalMemoryCandidate['status']) =>
  sidecarCall<GlobalMemoryCandidate[]>(
    MEMORY_IPC_CHANNELS.LIST_GLOBAL_CANDIDATES,
    status ? { status } : {}
  )

export const promoteGlobalMemory = (input: PromoteGlobalMemoryInput) =>
  sidecarCall<MemoryItem>(MEMORY_IPC_CHANNELS.PROMOTE_GLOBAL, input)

export const rejectGlobalMemoryCandidate = (candidateId: string) =>
  sidecarCall<GlobalMemoryCandidate>(MEMORY_IPC_CHANNELS.REJECT_GLOBAL_CANDIDATE, { candidateId })

export const getMemoryRuntimeConfig = () =>
  sidecarCall<MemoryRuntimeConfig>(MEMORY_IPC_CHANNELS.GET_RUNTIME_CONFIG, {})

export const updateMemoryRuntimeConfig = (input: UpdateMemoryRuntimeConfigInput) =>
  sidecarCall<MemoryRuntimeConfig>(MEMORY_IPC_CHANNELS.UPDATE_RUNTIME_CONFIG, input)
