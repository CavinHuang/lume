import type {
  WikiApplyDraftCommandInput,
  WikiCreateEditDraftInput,
  WikiCreateImportDraftInput,
  WikiCreatePrivacyPurgeDraftInput,
  WikiResolvePendingCommandInput,
  WikiSearchInput,
  WikiSearchScope,
  WikiUndoBatchCommandInput,
} from "@lume/shared";
import { WIKI_IPC_CHANNELS } from "@lume/shared";
import { WIKI_CAPABILITIES } from "../services/wiki/wiki-capabilities";
import { getWikiService } from "../services/wiki/wiki-service";
import { prepareWikiRuntimeCapability } from "../services/wiki/wiki-runtime-capability";
import { assertWikiPrivilegedCredential } from "../services/wiki/privileged-auth";
import { createWikiProposalSummary } from "../services/wiki/proposal-summary";
import type { RpcHandler } from "./types";

function object(value: unknown, method: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${method} 参数非法`);
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 必须是非空字符串`);
  return value;
}

function scope(value: unknown): WikiSearchScope {
  const input = object(value, "Wiki scope");
  const kind = string(input.kind, "scope.kind");
  if (kind === "all" || kind === "inbox") return { kind };
  if (kind === "workspace") return { kind, workspaceId: string(input.workspaceId, "scope.workspaceId") };
  if (kind === "page") return { kind, pageId: string(input.pageId, "scope.pageId") };
  throw new Error("Wiki scope.kind 非法");
}

function privilegedRequest(params: unknown, method: string): Record<string, unknown> {
  const input = object(params, method);
  assertWikiPrivilegedCredential(input.credential);
  return object(input.request, `${method}.request`);
}

function publicMutationResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || !("draft" in result)) return result;
  const pending = result as { id: string; draft: Parameters<typeof createWikiProposalSummary>[0]; createdAt: string; reason: string; requiresRegeneration?: boolean };
  return {
    id: pending.id,
    draft: createWikiProposalSummary(pending.draft),
    createdAt: pending.createdAt,
    reason: pending.reason,
    ...(pending.requiresRegeneration ? { requiresRegeneration: true } : {}),
  };
}

export function createWikiHandlers(): Record<string, RpcHandler> {
  const service = () => getWikiService();
  return {
    [WIKI_IPC_CHANNELS.GET_SNAPSHOT]: async () => service().getSnapshot(),
    [WIKI_IPC_CHANNELS.GET_CAPABILITIES]: async () => WIKI_CAPABILITIES,
    [WIKI_IPC_CHANNELS.PREPARE_RUNTIME]: async () => prepareWikiRuntimeCapability(),
    [WIKI_IPC_CHANNELS.SEARCH]: async (params) => {
      const input = object(params, WIKI_IPC_CHANNELS.SEARCH);
      return service().search({ query: typeof input.query === "string" ? input.query : "", scope: scope(input.scope), maxResults: typeof input.maxResults === "number" ? input.maxResults : undefined } satisfies WikiSearchInput);
    },
    [WIKI_IPC_CHANNELS.READ]: async (params) => {
      const input = object(params, WIKI_IPC_CHANNELS.READ);
      return service().read(string(input.pageId, "pageId"), scope(input.scope));
    },
    [WIKI_IPC_CHANNELS.FOLLOW_LINKS]: async (params) => {
      const input = object(params, WIKI_IPC_CHANNELS.FOLLOW_LINKS);
      const wiki = service();
      return wiki.followLinks(string(input.pageId, "pageId"), scope(input.scope), wiki.ownerSubject(), typeof input.depth === "number" ? input.depth : 1);
    },
    [WIKI_IPC_CHANNELS.CREATE_IMPORT_DRAFT]: async (params) => {
      const draft = await service().createImportDraft(object(params, WIKI_IPC_CHANNELS.CREATE_IMPORT_DRAFT) as unknown as WikiCreateImportDraftInput);
      return service().coordinator.getProposalSummary(draft.id);
    },
    [WIKI_IPC_CHANNELS.CREATE_EDIT_DRAFT]: async (params) => {
      const draft = service().createEditDraft(object(params, WIKI_IPC_CHANNELS.CREATE_EDIT_DRAFT) as unknown as WikiCreateEditDraftInput);
      return service().coordinator.getProposalSummary(draft.id);
    },
    [WIKI_IPC_CHANNELS.GET_DRAFT_STATUS]: async (params) => service().coordinator.getDraftStatus(
      string(object(params, WIKI_IPC_CHANNELS.GET_DRAFT_STATUS).draftId, "draftId")
    ),
    [WIKI_IPC_CHANNELS.CANCEL_DRAFT]: async (params) => {
      service().coordinator.cancelDraft(string(object(params, WIKI_IPC_CHANNELS.CANCEL_DRAFT).draftId, "draftId"));
      return { ok: true };
    },
    [WIKI_IPC_CHANNELS.LIST_PENDING]: async () => service().coordinator.listPendingSummaries(),
    [WIKI_IPC_CHANNELS.PRIVILEGED_GET_PROPOSAL_SUMMARY]: async (params) => {
      const input = privilegedRequest(params, WIKI_IPC_CHANNELS.PRIVILEGED_GET_PROPOSAL_SUMMARY);
      return service().coordinator.getProposalSummary(string(input.draftId, "draftId"));
    },
    [WIKI_IPC_CHANNELS.PRIVILEGED_APPLY_DRAFT]: async (params) => {
      const input = privilegedRequest(params, WIKI_IPC_CHANNELS.PRIVILEGED_APPLY_DRAFT);
      const wiki = service();
      const result = wiki.coordinator.applyDraftPrivileged({ draftId: string(input.draftId, "draftId"), expectedRevision: Number(input.expectedRevision), diffHash: string(input.diffHash, "diffHash") } satisfies WikiApplyDraftCommandInput);
      if ("state" in result && result.state === "committed") { wiki.index.rebuild(); wiki.runLint(); }
      return publicMutationResult(result);
    },
    [WIKI_IPC_CHANNELS.PRIVILEGED_RESOLVE_PENDING]: async (params) => {
      const input = privilegedRequest(params, WIKI_IPC_CHANNELS.PRIVILEGED_RESOLVE_PENDING);
      const action = input.action;
      if (action !== "accept" && action !== "reject") throw new Error("action 非法");
      const wiki = service();
      const result = wiki.coordinator.resolvePendingPrivileged({ pendingId: string(input.pendingId, "pendingId"), action, expectedRevision: Number(input.expectedRevision), diffHash: string(input.diffHash, "diffHash") } satisfies WikiResolvePendingCommandInput);
      if ("state" in result && result.state === "committed") { wiki.index.rebuild(); wiki.runLint(); }
      return publicMutationResult(result);
    },
    [WIKI_IPC_CHANNELS.PRIVILEGED_GET_UNDO_SUMMARY]: async (params) => {
      const input = privilegedRequest(params, WIKI_IPC_CHANNELS.PRIVILEGED_GET_UNDO_SUMMARY);
      return service().coordinator.getUndoSummary(string(input.batchId, "batchId"));
    },
    [WIKI_IPC_CHANNELS.PRIVILEGED_UNDO_BATCH]: async (params) => {
      const input = privilegedRequest(params, WIKI_IPC_CHANNELS.PRIVILEGED_UNDO_BATCH);
      const wiki = service();
      const result = wiki.coordinator.undoPrivileged({ batchId: string(input.batchId, "batchId"), expectedBatchRevision: Number(input.expectedBatchRevision), expectedCurrentStateHash: string(input.expectedCurrentStateHash, "expectedCurrentStateHash") } satisfies WikiUndoBatchCommandInput);
      if ("state" in result && result.state === "committed") { wiki.index.rebuild(); wiki.runLint(); }
      return publicMutationResult(result);
    },
    [WIKI_IPC_CHANNELS.RUN_LINT]: async () => service().runLint(),
    [WIKI_IPC_CHANNELS.PREVIEW_PRIVACY_PURGE]: async (params) => service().previewPrivacyPurge(
      object(params, WIKI_IPC_CHANNELS.PREVIEW_PRIVACY_PURGE).selector as WikiCreatePrivacyPurgeDraftInput["selector"]
    ),
    [WIKI_IPC_CHANNELS.CREATE_PRIVACY_PURGE_DRAFT]: async (params) => {
      const draft = service().createPrivacyPurgeDraft(object(params, WIKI_IPC_CHANNELS.CREATE_PRIVACY_PURGE_DRAFT) as unknown as WikiCreatePrivacyPurgeDraftInput);
      return service().coordinator.getProposalSummary(draft.id);
    },
    [WIKI_IPC_CHANNELS.ARCHIVE_WORKSPACE]: async (params) => {
      service().archiveWorkspace(string(object(params, WIKI_IPC_CHANNELS.ARCHIVE_WORKSPACE).workspaceId, "workspaceId"));
      return { ok: true };
    },
    [WIKI_IPC_CHANNELS.CREATE_ASK_THREAD]: async (params) => service().createAskThread(scope(object(params, WIKI_IPC_CHANNELS.CREATE_ASK_THREAD).scope)),
  };
}
