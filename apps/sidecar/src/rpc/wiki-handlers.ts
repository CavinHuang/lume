import type {
  WikiConfirmDraftInput,
  WikiCreateEditDraftInput,
  WikiCreateImportDraftInput,
  WikiSearchInput,
  WikiSearchScope,
} from "@lume/shared";
import { WIKI_IPC_CHANNELS } from "@lume/shared";
import { WIKI_CAPABILITIES } from "../services/wiki/wiki-capabilities";
import { getWikiService } from "../services/wiki/wiki-service";
import { prepareWikiRuntimeCapability } from "../services/wiki/wiki-runtime-capability";
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
    [WIKI_IPC_CHANNELS.CREATE_IMPORT_DRAFT]: async (params) => service().createImportDraft(object(params, WIKI_IPC_CHANNELS.CREATE_IMPORT_DRAFT) as unknown as WikiCreateImportDraftInput),
    [WIKI_IPC_CHANNELS.CREATE_EDIT_DRAFT]: async (params) => service().createEditDraft(object(params, WIKI_IPC_CHANNELS.CREATE_EDIT_DRAFT) as unknown as WikiCreateEditDraftInput),
    [WIKI_IPC_CHANNELS.APPLY_DRAFT]: async (params) => {
      const input = object(params, WIKI_IPC_CHANNELS.APPLY_DRAFT);
      const confirm: WikiConfirmDraftInput = { draftId: string(input.draftId, "draftId"), expectedRevision: Number(input.expectedRevision), nonce: string(input.nonce, "nonce") };
      const wiki = service();
      const result = wiki.coordinator.applyDraft(confirm);
      if ("state" in result && result.state === "committed") { wiki.index.rebuild(); wiki.runLint(); }
      return result;
    },
    [WIKI_IPC_CHANNELS.CANCEL_DRAFT]: async (params) => {
      service().coordinator.cancelDraft(string(object(params, WIKI_IPC_CHANNELS.CANCEL_DRAFT).draftId, "draftId"));
      return { ok: true };
    },
    [WIKI_IPC_CHANNELS.LIST_PENDING]: async () => service().coordinator.listPending(),
    [WIKI_IPC_CHANNELS.RESOLVE_PENDING]: async (params) => {
      const input = object(params, WIKI_IPC_CHANNELS.RESOLVE_PENDING);
      const action = input.action;
      if (action !== "accept" && action !== "reject") throw new Error("action 非法");
      const wiki = service();
      const result = wiki.coordinator.resolvePending(string(input.id, "id"), action);
      if ("state" in result && result.state === "committed") { wiki.index.rebuild(); wiki.runLint(); }
      return result;
    },
    [WIKI_IPC_CHANNELS.UNDO_BATCH]: async (params) => {
      const wiki = service();
      const result = wiki.coordinator.undo(string(object(params, WIKI_IPC_CHANNELS.UNDO_BATCH).batchId, "batchId"));
      if ("state" in result && result.state === "committed") { wiki.index.rebuild(); wiki.runLint(); }
      return result;
    },
    [WIKI_IPC_CHANNELS.RUN_LINT]: async () => service().runLint(),
    [WIKI_IPC_CHANNELS.ARCHIVE_WORKSPACE]: async (params) => {
      service().archiveWorkspace(string(object(params, WIKI_IPC_CHANNELS.ARCHIVE_WORKSPACE).workspaceId, "workspaceId"));
      return { ok: true };
    },
    [WIKI_IPC_CHANNELS.CREATE_ASK_THREAD]: async (params) => service().createAskThread(scope(object(params, WIKI_IPC_CHANNELS.CREATE_ASK_THREAD).scope)),
  };
}
