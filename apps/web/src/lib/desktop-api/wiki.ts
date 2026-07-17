import type {
  WikiBatch,
  WikiCapabilityMatrix,
  WikiChangeDraft,
  WikiConfirmDraftInput,
  WikiCreateEditDraftInput,
  WikiCreateImportDraftInput,
  WikiLintFinding,
  WikiPageRecord,
  WikiPendingReview,
  WikiReadResult,
  WikiSearchInput,
  WikiSearchResult,
  WikiSearchScope,
  WikiSnapshot,
} from '@lume/shared'
import { WIKI_IPC_CHANNELS } from '@lume/shared'
import { sidecarCall } from './system'

export const getWikiSnapshot = () => sidecarCall<WikiSnapshot>(WIKI_IPC_CHANNELS.GET_SNAPSHOT, {})
export const getWikiCapabilities = () => sidecarCall<WikiCapabilityMatrix>(WIKI_IPC_CHANNELS.GET_CAPABILITIES, {})
export const searchWiki = (input: WikiSearchInput) => sidecarCall<WikiSearchResult[]>(WIKI_IPC_CHANNELS.SEARCH, input)
export const readWikiPage = (pageId: string, scope: WikiSearchScope) => sidecarCall<WikiReadResult>(WIKI_IPC_CHANNELS.READ, { pageId, scope })
export const followWikiLinks = (pageId: string, scope: WikiSearchScope, depth = 1) => sidecarCall<WikiPageRecord[]>(WIKI_IPC_CHANNELS.FOLLOW_LINKS, { pageId, scope, depth })
export const createWikiImportDraft = (input: WikiCreateImportDraftInput) => sidecarCall<WikiChangeDraft>(WIKI_IPC_CHANNELS.CREATE_IMPORT_DRAFT, input)
export const createWikiEditDraft = (input: WikiCreateEditDraftInput) => sidecarCall<WikiChangeDraft>(WIKI_IPC_CHANNELS.CREATE_EDIT_DRAFT, input)
export const applyWikiDraft = (input: WikiConfirmDraftInput) => sidecarCall<WikiBatch | WikiPendingReview>(WIKI_IPC_CHANNELS.APPLY_DRAFT, input)
export const cancelWikiDraft = (draftId: string) => sidecarCall<{ ok: true }>(WIKI_IPC_CHANNELS.CANCEL_DRAFT, { draftId })
export const listWikiPending = () => sidecarCall<WikiPendingReview[]>(WIKI_IPC_CHANNELS.LIST_PENDING, {})
export const resolveWikiPending = (id: string, action: 'accept' | 'reject') => sidecarCall<unknown>(WIKI_IPC_CHANNELS.RESOLVE_PENDING, { id, action })
export const undoWikiBatch = (batchId: string) => sidecarCall<WikiBatch | WikiPendingReview>(WIKI_IPC_CHANNELS.UNDO_BATCH, { batchId })
export const runWikiLint = () => sidecarCall<WikiLintFinding[]>(WIKI_IPC_CHANNELS.RUN_LINT, {})
export const archiveWikiWorkspace = (workspaceId: string) => sidecarCall<{ ok: true }>(WIKI_IPC_CHANNELS.ARCHIVE_WORKSPACE, { workspaceId })
export const createAskWikiThread = (scope: WikiSearchScope) => sidecarCall<{ threadId: string }>(WIKI_IPC_CHANNELS.CREATE_ASK_THREAD, { scope })
