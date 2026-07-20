import type {
  WikiBatch,
  WikiCapabilityMatrix,
  WikiDraftStatus,
  WikiCreateEditDraftInput,
  WikiCreateImportDraftInput,
  WikiCreatePrivacyPurgeDraftInput,
  WikiLintFinding,
  WikiPageRecord,
  WikiPendingReviewSummary,
  WikiProposalSummaryV1,
  WikiPrivacyImpactPreview,
  WikiPrivacySelector,
  WikiReadResult,
  WikiSearchInput,
  WikiSearchResult,
  WikiSearchScope,
  WikiSnapshot,
  WikiUndoSummaryV1,
} from '@lume/shared'
import { WIKI_DESKTOP_COMMANDS, WIKI_IPC_CHANNELS } from '@lume/shared'
import { invoke } from '@/lib/desktop-runtime/core'
import { sidecarCall } from './system'

export const getWikiSnapshot = () => sidecarCall<WikiSnapshot>(WIKI_IPC_CHANNELS.GET_SNAPSHOT, {})
export const getWikiCapabilities = () => sidecarCall<WikiCapabilityMatrix>(WIKI_IPC_CHANNELS.GET_CAPABILITIES, {})
export const prepareWikiRuntime = () => sidecarCall<WikiCapabilityMatrix>(WIKI_IPC_CHANNELS.PREPARE_RUNTIME, {})
export const searchWiki = (input: WikiSearchInput) => sidecarCall<WikiSearchResult[]>(WIKI_IPC_CHANNELS.SEARCH, input)
export const readWikiPage = (pageId: string, scope: WikiSearchScope) => sidecarCall<WikiReadResult>(WIKI_IPC_CHANNELS.READ, { pageId, scope })
export const followWikiLinks = (pageId: string, scope: WikiSearchScope, depth = 1) => sidecarCall<WikiPageRecord[]>(WIKI_IPC_CHANNELS.FOLLOW_LINKS, { pageId, scope, depth })
export const createWikiImportDraft = (input: WikiCreateImportDraftInput) => sidecarCall<WikiProposalSummaryV1>(WIKI_IPC_CHANNELS.CREATE_IMPORT_DRAFT, input)
export const createWikiEditDraft = (input: WikiCreateEditDraftInput) => sidecarCall<WikiProposalSummaryV1>(WIKI_IPC_CHANNELS.CREATE_EDIT_DRAFT, input)
export const getWikiProposalSummary = (draftId: string) => invoke<WikiProposalSummaryV1>(WIKI_DESKTOP_COMMANDS.GET_PROPOSAL_SUMMARY, { draftId })
export const applyWikiDraft = async (draftId: string) => {
  const summary = await getWikiProposalSummary(draftId)
  return invoke<WikiBatch | WikiPendingReviewSummary>(WIKI_DESKTOP_COMMANDS.APPLY_DRAFT, {
    draftId: summary.draftId,
    expectedRevision: summary.revision,
    diffHash: summary.diffHash,
  })
}
export const getWikiDraftStatus = (draftId: string) => sidecarCall<WikiDraftStatus>(WIKI_IPC_CHANNELS.GET_DRAFT_STATUS, { draftId })
export const cancelWikiDraft = (draftId: string) => sidecarCall<{ ok: true }>(WIKI_IPC_CHANNELS.CANCEL_DRAFT, { draftId })
export const listWikiPending = () => sidecarCall<WikiPendingReviewSummary[]>(WIKI_IPC_CHANNELS.LIST_PENDING, {})
export const resolveWikiPending = async (pending: WikiPendingReviewSummary, action: 'accept' | 'reject') => {
  const summary = await getWikiProposalSummary(pending.draft.draftId)
  return invoke<unknown>(WIKI_DESKTOP_COMMANDS.RESOLVE_PENDING, {
    pendingId: pending.id,
    action,
    expectedRevision: summary.revision,
    diffHash: summary.diffHash,
  })
}
export const undoWikiBatch = async (batchId: string) => {
  const summary = await invoke<WikiUndoSummaryV1>(WIKI_DESKTOP_COMMANDS.GET_UNDO_SUMMARY, { batchId })
  return invoke<WikiBatch | WikiPendingReviewSummary>(WIKI_DESKTOP_COMMANDS.UNDO_BATCH, {
    batchId: summary.batchId,
    expectedBatchRevision: summary.expectedBatchRevision,
    expectedCurrentStateHash: summary.expectedCurrentStateHash,
  })
}
export const runWikiLint = () => sidecarCall<WikiLintFinding[]>(WIKI_IPC_CHANNELS.RUN_LINT, {})
export const previewWikiPrivacyPurge = (selector: WikiPrivacySelector) => sidecarCall<WikiPrivacyImpactPreview>(WIKI_IPC_CHANNELS.PREVIEW_PRIVACY_PURGE, { selector })
export const createWikiPrivacyPurgeDraft = (input: WikiCreatePrivacyPurgeDraftInput) => sidecarCall<WikiProposalSummaryV1>(WIKI_IPC_CHANNELS.CREATE_PRIVACY_PURGE_DRAFT, input)
export const archiveWikiWorkspace = (workspaceId: string) => sidecarCall<{ ok: true }>(WIKI_IPC_CHANNELS.ARCHIVE_WORKSPACE, { workspaceId })
export const createAskWikiThread = (scope: WikiSearchScope) => sidecarCall<{ threadId: string }>(WIKI_IPC_CHANNELS.CREATE_ASK_THREAD, { scope })
