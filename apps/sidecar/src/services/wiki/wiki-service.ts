import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { extractArticleMarkdown } from "@lume/agent-sdk";
import type {
  WikiChangeDraft, WikiCreateEditDraftInput, WikiCreateImportDraftInput,
  WikiPageRecord, WikiReadResult, WikiSearchInput, WikiSearchResult, WikiSnapshot,
  WikiPageType, WikiSourceKind, WikiTrustedSubject, WikiWorkspaceSnapshot
} from "@lume/shared";
import { getAgentThreadMessages, getAgentThreadMeta, createAgentThread } from "../agent/agent-thread-manager";
import { getAgentWorkspace, listAgentWorkspaces } from "../agent/agent-workspace-manager";
import { getReadingNote } from "../reading/reading-store";
import { createMemoryV2Store } from "../memory-v2/markdown-store";
import { getWikiRootPath } from "../infra/config-paths";
import { pageAllowed, sourceAllowed } from "./acl-store";
import { WikiIndexService } from "./index-service";
import { WikiHealthStore } from "./health-store";
import { WikiLintService } from "./lint-service";
import { createWikiPageMarkdown, extractWikiLinks, parseWikiPage, serializeWikiPage, sha256, wikiPageRelativePath } from "./markdown-store";
import { WikiMutationCoordinator } from "./mutation-coordinator";
import { assertExternalPathWithin } from "./path-security";
import { WikiSafeHttpFetchService } from "./safe-http-fetch";
import { WIKI_CAPABILITIES } from "./wiki-capabilities";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_BATCH_BYTES = 250 * 1024 * 1024;
const MAX_FILES = 500;

export interface WikiAgentProposalInput {
  action: "create" | "update";
  title: string;
  body: string;
  pageType?: Exclude<WikiPageType, "source">;
  pageId?: string;
  expectedHash?: string;
  primaryWorkspaceId?: string | null;
}

export class WikiService {
  readonly root: string;
  readonly coordinator: WikiMutationCoordinator;
  readonly index: WikiIndexService;
  readonly health: WikiHealthStore;
  private findings = [] as ReturnType<WikiLintService["run"]>;

  constructor(input: { root?: string; safeFetch?: WikiSafeHttpFetchService } = {}) {
    this.root = input.root ?? getWikiRootPath();
    this.coordinator = new WikiMutationCoordinator(this.root);
    this.coordinator.recoverInterrupted();
    this.index = new WikiIndexService(this.root, this.coordinator.markdown);
    this.health = new WikiHealthStore(this.root);
    this.safeFetch = input.safeFetch ?? new WikiSafeHttpFetchService();
  }
  private readonly safeFetch: WikiSafeHttpFetchService;

  ownerSubject(): WikiTrustedSubject { return { kind: "desktop_owner", subjectId: "local-owner", workspaceIds: [], allowInbox: true, allowAll: true }; }

  getSnapshot(): WikiSnapshot {
    this.coordinator.markdown.ensureLayout();
    this.coordinator.recoverInterrupted();
    const pages = this.coordinator.markdown.listPages();
    const generation = this.index.ensureFresh();
    if (this.findings.length === 0) this.findings = new WikiLintService(this.coordinator.markdown).run(generation);
    return {
      rootPath: this.root, pages, pending: this.coordinator.listPending(), findings: this.findings, generation,
      recentBatches: this.coordinator.listBatches(),
      semanticCheck: this.health.evaluate(generation, this.findings),
      capabilities: WIKI_CAPABILITIES
    };
  }

  search(input: WikiSearchInput, subject = this.ownerSubject()): WikiSearchResult[] {
    const visible = this.coordinator.markdown.listPages().filter((page) => page.status !== "trashed"
      && (input.scope.kind !== "page" || page.id === input.scope.pageId)
      && pageAllowed(page.frontmatter, subject, input.scope));
    return this.index.search(input.query, visible, input.maxResults);
  }

  read(pageId: string, scope: WikiSearchInput["scope"], subject = this.ownerSubject()): WikiReadResult {
    const pages = this.coordinator.markdown.listPages();
    const page = pages.find((item) => item.id === pageId);
    if (!page || (scope.kind === "page" && scope.pageId !== page.id) || !pageAllowed(page.frontmatter, subject, scope)) throw new Error("Wiki 页面不存在或未授权");
    const byFileKey = new Map(pages.map((item) => [item.fileKey, item]));
    const links = extractWikiLinks(page.body).map((key) => byFileKey.get(key)).filter((item): item is WikiPageRecord => Boolean(item && scope.kind !== "page" && pageAllowed(item.frontmatter, subject, scope)));
    const backlinks = scope.kind === "page" ? [] : pages.filter((item) => extractWikiLinks(item.body).includes(page.fileKey) && pageAllowed(item.frontmatter, subject, scope));
    const sources = page.frontmatter.source_ids.map((id) => {
      const ref = this.coordinator.sources.toRef(id);
      if (!ref) return undefined;
      if (!sourceAllowed(id, page.frontmatter, subject, scope, this.coordinator.acl)) return { ...ref, blobHash: undefined, restricted: true, warning: "页面可见，但原始来源 grant 不允许下钻" };
      const payload = this.coordinator.sources.readPayload(id);
      return { ...ref, ...(payload ? { content: new TextDecoder().decode(payload).slice(0, 100_000) } : {}) };
    }).filter(Boolean) as WikiReadResult["sources"];
    return { page, sources, links, backlinks };
  }

  followLinks(pageId: string, scope: WikiSearchInput["scope"], subject: WikiTrustedSubject, depth = 1): WikiPageRecord[] {
    const seen = new Set<string>();
    let frontier = [this.read(pageId, scope, subject).page];
    for (let level = 0; level < Math.min(3, Math.max(1, depth)); level += 1) {
      const next: WikiPageRecord[] = [];
      for (const page of frontier) {
        if (seen.has(page.id)) continue;
        seen.add(page.id);
        next.push(...this.read(page.id, scope, subject).links
          .map((link) => this.coordinator.markdown.readById(link.id))
          .filter((link): link is WikiPageRecord => Boolean(link)));
      }
      frontier = next;
    }
    return [...seen].map((id) => this.coordinator.markdown.readById(id)).filter(Boolean) as WikiPageRecord[];
  }

  async createImportDraft(input: WikiCreateImportDraftInput, origin: WikiChangeDraft["origin"] = "import"): Promise<WikiChangeDraft> {
    const primary = input.primaryWorkspaceId ? workspaceSnapshot(input.primaryWorkspaceId) : null;
    const associatedWorkspaceIds = validateWorkspaceIds(input.associatedWorkspaceIds ?? []).filter((id) => id !== primary?.id);
    const captures = await this.capture(input);
    const sourceIds = captures.map((capture) => capture.manifest.id);
    const existing = input.updatePageId ? this.coordinator.markdown.readById(input.updatePageId) : undefined;
    const title = input.title?.trim() || captures[0]?.manifest.title || "未命名 Wiki 页面";
    const body = buildImportedBody(captures.map((capture) => ({ title: capture.manifest.title, sourceId: capture.manifest.id, text: capture.text })));
    const markdown = existing
      ? serializeWikiPage({ ...existing.frontmatter, title, updated: new Date().toISOString(), revision: existing.revision + 1, source_ids: [...new Set([...existing.frontmatter.source_ids, ...sourceIds])] }, `${existing.body.trimEnd()}\n\n${body}`)
      : createWikiPageMarkdown({ type: input.pageType ?? (captures.length === 1 ? "source" : "synthesis"), title, primaryWorkspace: primary, associatedWorkspaceIds, sourceIds, body });
    const page = parseWikiPage(markdown);
    const targetRelativePath = existing?.path ?? wikiPageRelativePath(page.frontmatter);
    const grants = validateWorkspaceIds(input.sourceGrantWorkspaceIds ?? (input.primaryWorkspaceId ? [input.primaryWorkspaceId] : []));
    const riskReasons = existing?.protected ? ["目标页面处于 protected 状态"] : [];
    return this.coordinator.stageDraft({
      origin, risk: riskReasons.length ? "high" : "low", riskReasons, title,
      operations: [{ kind: existing ? "update" : "create", pageId: page.id, beforeHash: existing?.hash ?? null, targetRelativePath, markdown }],
      sources: captures.map((capture) => ({ manifest: capture.manifest, grants })),
      diffs: [{ path: targetRelativePath, beforeHash: existing?.hash ?? null, afterHash: sha256(markdown), preview: existing ? `更新 ${existing.title}` : `新建 ${title}` }],
      pageVisibilityWorkspaceIds: [input.primaryWorkspaceId, ...associatedWorkspaceIds].filter(Boolean) as string[], sourceGrantWorkspaceIds: grants,
      payloads: Object.fromEntries(captures.filter((capture) => capture.payload).map((capture) => [capture.manifest.id, capture.payload!]))
    });
  }

  createEditDraft(input: WikiCreateEditDraftInput): WikiChangeDraft {
    const current = this.coordinator.markdown.readById(input.pageId);
    if (!current || current.hash !== input.expectedHash) throw new Error("页面已在其他编辑器中变化，请重新加载");
    const primary = input.primaryWorkspaceId ? workspaceSnapshot(input.primaryWorkspaceId) : null;
    const associatedWorkspaceIds = validateWorkspaceIds(input.associatedWorkspaceIds).filter((id) => id !== primary?.id);
    const frontmatter = {
      ...current.frontmatter, title: input.title.trim(), type: input.type,
      primary_workspace_id: primary?.id ?? null, primary_workspace_snapshot: primary,
      associated_workspace_ids: associatedWorkspaceIds, aliases: input.aliases, tags: input.tags,
      updated: new Date().toISOString(), revision: current.revision + 1
    };
    const markdown = serializeWikiPage(frontmatter, input.body);
    const target = wikiPageRelativePath(frontmatter);
    return this.coordinator.stageDraft({
      origin: "ui", risk: current.protected ? "high" : "low",
      riskReasons: current.protected ? ["页面因外部编辑冲突处于 protected 状态"] : [], title: `保存 ${frontmatter.title}`,
      operations: [{ kind: target === current.path ? "update" : "move", pageId: current.id, beforeHash: current.hash, targetRelativePath: target, previousRelativePath: current.path, markdown }],
      sources: [], diffs: [{ path: target, beforeHash: current.hash, afterHash: sha256(markdown), preview: `保存 revision ${frontmatter.revision}` }],
      pageVisibilityWorkspaceIds: [frontmatter.primary_workspace_id, ...frontmatter.associated_workspace_ids].filter(Boolean) as string[], sourceGrantWorkspaceIds: []
    });
  }

  createAgentProposalDraft(
    input: WikiAgentProposalInput,
    scope: WikiSearchInput["scope"],
    subject: WikiTrustedSubject
  ): WikiChangeDraft {
    if (input.action === "update") {
      if (!input.pageId || !input.expectedHash) throw new Error("更新提案需要 pageId 与 expectedHash");
      const current = this.read(input.pageId, scope, subject).page;
      if (current.hash !== input.expectedHash) throw new Error("Wiki 页面已变化，请重新读取后再提案");
      const frontmatter = {
        ...current.frontmatter,
        title: input.title.trim() || current.title,
        type: input.pageType ?? current.type,
        updated: new Date().toISOString(),
        revision: current.revision + 1
      };
      const markdown = serializeWikiPage(frontmatter, input.body);
      const target = wikiPageRelativePath(frontmatter);
      return this.coordinator.stageDraft({
        origin: "agent",
        risk: current.protected ? "high" : "low",
        riskReasons: current.protected ? ["目标页面处于 protected 状态"] : [],
        title: `Agent 建议更新 ${frontmatter.title}`,
        operations: [{
          kind: target === current.path ? "update" : "move",
          pageId: current.id,
          beforeHash: current.hash,
          targetRelativePath: target,
          ...(target === current.path ? {} : { previousRelativePath: current.path }),
          markdown
        }],
        sources: [],
        diffs: [{ path: target, beforeHash: current.hash, afterHash: sha256(markdown), preview: `建议更新 revision ${frontmatter.revision}` }],
        pageVisibilityWorkspaceIds: [frontmatter.primary_workspace_id, ...frontmatter.associated_workspace_ids].filter(Boolean) as string[],
        sourceGrantWorkspaceIds: []
      });
    }

    if (scope.kind === "page") throw new Error("页面级 Wiki scope 不能新建页面");
    const primaryWorkspaceId = scope.kind === "workspace"
      ? scope.workspaceId
      : scope.kind === "inbox"
        ? null
        : input.primaryWorkspaceId ?? null;
    const primary = primaryWorkspaceId ? workspaceSnapshot(primaryWorkspaceId) : null;
    const title = input.title.trim();
    if (!title) throw new Error("新建提案需要标题");
    const markdown = createWikiPageMarkdown({
      type: input.pageType ?? "synthesis",
      title,
      primaryWorkspace: primary,
      associatedWorkspaceIds: [],
      sourceIds: [],
      body: input.body
    });
    const page = parseWikiPage(markdown);
    const targetRelativePath = wikiPageRelativePath(page.frontmatter);
    return this.coordinator.stageDraft({
      origin: "agent",
      risk: "low",
      riskReasons: [],
      title: `Agent 建议新建 ${title}`,
      operations: [{ kind: "create", pageId: page.id, beforeHash: null, targetRelativePath, markdown }],
      sources: [],
      diffs: [{ path: targetRelativePath, beforeHash: null, afterHash: sha256(markdown), preview: `建议新建 ${title}` }],
      pageVisibilityWorkspaceIds: primaryWorkspaceId ? [primaryWorkspaceId] : [],
      sourceGrantWorkspaceIds: []
    });
  }

  runLint(): ReturnType<WikiLintService["run"]> { this.findings = new WikiLintService(this.coordinator.markdown).run(this.index.ensureFresh()); return this.findings; }

  archiveWorkspace(workspaceId: string): void {
    const pages = this.coordinator.markdown.listPages().filter((page) => page.primaryWorkspaceId === workspaceId && page.status !== "archived");
    if (pages.length === 0) { this.coordinator.acl.revokeWorkspace(workspaceId, "workspace-lifecycle"); return; }
    const operations = pages.map((page) => {
      const fm = { ...page.frontmatter, status: "archived" as const, updated: new Date().toISOString(), revision: page.revision + 1 };
      const markdown = serializeWikiPage(fm, page.body);
      return { kind: "move" as const, pageId: page.id, beforeHash: page.hash, previousRelativePath: page.path, targetRelativePath: wikiPageRelativePath(fm), markdown };
    });
    const draft = this.coordinator.stageDraft({ origin: "ui", risk: "low", riskReasons: [], title: `归档工作区 Wiki: ${workspaceId}`, operations, sources: [], diffs: operations.map((operation) => ({ path: operation.targetRelativePath, beforeHash: operation.beforeHash, afterHash: sha256(operation.markdown), preview: "工作区逻辑归档" })), pageVisibilityWorkspaceIds: [workspaceId], sourceGrantWorkspaceIds: [] });
    this.coordinator.applyDraft({ draftId: draft.id, expectedRevision: draft.revision, nonce: draft.nonce }, "workspace-lifecycle");
    this.coordinator.acl.revokeWorkspace(workspaceId, "workspace-lifecycle");
    this.index.rebuild();
  }

  createAskThread(scope: WikiSearchInput["scope"]): { threadId: string } {
    const workspaceId = scope.kind === "workspace" ? scope.workspaceId : undefined;
    const thread = createAgentThread("向 Wiki 提问", undefined, workspaceId, undefined, undefined, { wikiProfile: { kind: "ask-wiki", scope } });
    return { threadId: thread.id };
  }

  private async capture(input: WikiCreateImportDraftInput): Promise<Array<{ manifest: ReturnType<WikiMutationCoordinator["sources"]["createManifest"]>["manifest"]; payload?: Uint8Array; text: string }>> {
    const rawItems = await resolveImportItems(input, this.safeFetch);
    if (rawItems.length > MAX_FILES) throw new Error(`单批次最多 ${MAX_FILES} 个文件`);
    const total = rawItems.reduce((sum, item) => sum + item.bytes.byteLength, 0);
    if (total > MAX_BATCH_BYTES) throw new Error("Wiki 导入批次超过 250 MiB");
    return rawItems.map((item) => {
      const tooLarge = item.bytes.byteLength > MAX_FILE_BYTES;
      const mode = tooLarge ? "external_only" : "snapshotted";
      const created = this.coordinator.sources.createManifest({ kind: item.kind, title: item.title, capture_mode: mode, capture_scope_snapshot: item.scope, locator: item.locator, media_type: item.mediaType, warnings: tooLarge ? ["原件超过 25 MiB，未完整归档"] : item.warnings, payload: tooLarge ? new TextEncoder().encode(item.text) : item.bytes });
      return { manifest: created.manifest, payload: mode === "snapshotted" ? created.payload : undefined, text: item.text };
    });
  }
}

type RawImport = { kind: WikiSourceKind; title: string; text: string; bytes: Uint8Array; mediaType: string; locator: Record<string, unknown>; scope: { capturedBy: "desktop_owner"; workspaceId?: string; threadId?: string }; warnings: string[] };

async function resolveImportItems(input: WikiCreateImportDraftInput, safeFetch: WikiSafeHttpFetchService): Promise<RawImport[]> {
  const source = input.source;
  if (source.kind === "text") return [raw("text", source.title ?? input.title ?? "粘贴文本", source.text, {})];
  if (source.kind === "url") {
    const result = await safeFetch.fetch(source.url);
    const html = new TextDecoder().decode(result.body);
    const article = result.contentType.includes("html") ? extractArticleMarkdown(html, result.finalUrl) : null;
    const content = article?.content ?? html;
    return [{ ...raw("url", source.title ?? article?.title ?? new URL(result.finalUrl).hostname, content, { url: result.finalUrl }), bytes: result.body, mediaType: result.contentType }];
  }
  if (source.kind === "chat") {
    const meta = getAgentThreadMeta(source.threadId);
    if (!meta) throw new Error("聊天线程不存在");
    const messages = getAgentThreadMessages(source.threadId).filter((message) => source.messageIds.includes(message.id));
    return messages.map((message) => raw("chat", `聊天消息 ${message.id.slice(0, 8)}`, message.content, { threadId: source.threadId, messageId: message.id, versionGroupId: message.versionGroupId, versionIndex: message.versionIndex }, { threadId: source.threadId, workspaceId: meta.workspaceId }));
  }
  if (source.kind === "reading_note") {
    const note = getReadingNote(source.noteId); if (!note) throw new Error("读书笔记不存在");
    return [raw("reading_note", note.title, note.body, { readingNoteId: note.id })];
  }
  if (source.kind === "memory_entry") {
    const workspace = getAgentWorkspace(source.workspaceId); if (!workspace) throw new Error("工作区不存在");
    const entry = createMemoryV2Store().listEntries({ workspaceSlug: workspace.slug, scopes: ["workspace"] }).find((item) => item.frontmatter.id === source.entryId);
    if (!entry) throw new Error("Memory entry 不存在");
    return [raw("memory_entry", entry.frontmatter.id, entry.statement, { memoryEntryId: source.entryId, workspaceId: source.workspaceId }, { workspaceId: source.workspaceId })];
  }
  const basePath = source.kind === "workspace_file" ? getAgentWorkspace(source.workspaceId)?.projectPath : source.path;
  if (!basePath) throw new Error("导入路径不可用");
  const root = source.kind === "workspace_file" ? getAgentWorkspace(source.workspaceId)!.projectPath! : source.kind === "webfetch_asset" ? getAgentWorkspace(source.workspaceId)?.projectPath ?? source.path : source.kind === "file" ? source.rootPath ?? join(source.path, "..") : source.path;
  const target = assertExternalPathWithin(root, basePath);
  const files = lstatSync(target).isDirectory() ? collectFiles(target, target) : [target];
  return files.map((path) => {
    const bytes = readFileSync(path); const text = isTextFile(path) ? bytes.toString("utf8") : `[二进制文件 ${basename(path)}，仅保留快照与哈希]`;
    return { ...raw(source.kind === "workspace_file" ? "workspace_file" : source.kind === "webfetch_asset" ? "webfetch_asset" : "file", basename(path), text, { filePath: path, ...(source.kind === "workspace_file" ? { workspaceId: source.workspaceId } : {}) }), bytes, mediaType: isTextFile(path) ? "text/plain" : "application/octet-stream" };
  });
}

function collectFiles(root: string, directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = assertExternalPathWithin(root, join(directory, entry.name));
    if (entry.isSymbolicLink()) throw new Error("文件夹导入拒绝 symlink/junction");
    if (entry.isDirectory()) files.push(...collectFiles(root, path)); else if (entry.isFile()) files.push(path);
    if (files.length > MAX_FILES) throw new Error(`单批次最多 ${MAX_FILES} 个文件`);
  }
  return files;
}

function raw(kind: WikiSourceKind, title: string, text: string, locator: Record<string, unknown>, scope: { workspaceId?: string; threadId?: string } = {}): RawImport {
  return { kind, title, text, bytes: new TextEncoder().encode(text), mediaType: "text/markdown", locator, scope: { capturedBy: "desktop_owner", ...scope }, warnings: [] };
}
function isTextFile(path: string): boolean { return [".md", ".txt", ".json", ".yaml", ".yml", ".csv", ".ts", ".tsx", ".js", ".jsx", ".html", ".css"].includes(extname(path).toLowerCase()); }
function workspaceSnapshot(id: string): WikiWorkspaceSnapshot { const workspace = getAgentWorkspace(id); if (!workspace) throw new Error(`工作区不存在: ${id}`); return { id: workspace.id, name: workspace.name, slug: workspace.slug }; }
function validateWorkspaceIds(ids: string[]): string[] { return [...new Set(ids)].map((id) => workspaceSnapshot(id).id); }
function buildImportedBody(items: Array<{ title: string; sourceId: string; text: string }>): string { return `# 摘要\n\n已显式沉淀 ${items.length} 个不可变来源。\n\n# 已知内容\n\n${items.map((item) => `## ${item.title}\n\n> 来源: ${item.sourceId}\n\n${item.text.slice(0, 20_000)}`).join("\n\n")}\n\n# 用户批注\n\n# 开放问题\n\n# 相关页面\n`; }

let singleton: WikiService | undefined;
export function getWikiService(): WikiService { return singleton ??= new WikiService(); }
