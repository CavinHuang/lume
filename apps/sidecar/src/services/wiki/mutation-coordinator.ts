import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WikiApplyDraftCommandInput, WikiBatch, WikiChangeDraft, WikiConfirmDraftInput, WikiDraftCreator, WikiDraftOperation, WikiDraftStatus, WikiPendingReview, WikiPendingReviewSummary, WikiProposalSummaryV1, WikiResolvePendingCommandInput, WikiUndoBatchCommandInput, WikiUndoSummaryV1 } from "@lume/shared";
import { WikiAclStore } from "./acl-store";
import { promoteExternallyEditedBlocks, serializeWikiPage, sha256, WikiMarkdownStore } from "./markdown-store";
import { ensureWikiDirectory, processIsAlive, resolveWikiPath } from "./path-security";
import { WikiSourceStore } from "./source-store";
import { createWikiProposalSummary } from "./proposal-summary";

interface WikiWriterLock {
  ownerPid: number;
  ownerId: string;
  fencingToken: number;
  heartbeatAt: string;
}

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_AGENT_DRAFT_MARKDOWN_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_DRAFTS_PER_THREAD = 20;
const MAX_PENDING_DRAFTS = 200;
const MAX_STAGING_BYTES = 256 * 1024 * 1024;

export class WikiMutationCoordinator {
  readonly markdown: WikiMarkdownStore;
  readonly sources: WikiSourceStore;
  readonly acl: WikiAclStore;

  constructor(readonly root: string) {
    this.markdown = new WikiMarkdownStore(root);
    this.sources = new WikiSourceStore(root);
    this.acl = new WikiAclStore(root);
  }

  stageDraft(input: Omit<WikiChangeDraft, "id" | "revision" | "nonce" | "expiresAt" | "creator"> & { id?: string; creator?: WikiDraftCreator; payloads?: Record<string, Uint8Array> }): WikiChangeDraft {
    this.markdown.ensureLayout();
    const draftId = input.id ?? randomUUID();
    const creator = input.creator ?? defaultDraftCreator(input.origin);
    try {
      this.assertDraftQuota(input, creator);
    } catch (error) {
      this.appendSecurityAudit({
        event: "draft_rejected",
        draftId,
        creator,
        result: "rejected",
        rejectionCode: error instanceof Error ? error.message.split(":", 1)[0] : "WIKI_DRAFT_REJECTED",
      });
      throw error;
    }
    const directory = ensureWikiDirectory(this.root, join(".lume/staging", draftId));
    const sources = input.sources.map((source) => {
      const payload = input.payloads?.[source.manifest.id];
      if (!payload) return source;
      const relativePath = join(".lume/staging", draftId, `${source.manifest.id}.payload`);
      writeFileSync(resolveWikiPath(this.root, relativePath), payload, { flag: "wx" });
      return { ...source, payloadRelativePath: relativePath };
    });
    const draft: WikiChangeDraft = {
      ...input,
      id: draftId,
      revision: 1,
      nonce: randomBytes(32).toString("base64url"),
      creator,
      expiresAt: new Date(Date.now() + DRAFT_TTL_MS).toISOString(),
      sources
    };
    writeFileSync(join(directory, "draft.json"), JSON.stringify(draft, null, 2), { encoding: "utf8", flag: "wx" });
    this.appendSecurityAudit({
      event: "draft_staged",
      draftId,
      creator,
      diffHash: createWikiProposalSummary(draft).diffHash,
      result: "staged",
    });
    return draft;
  }

  loadDraft(draftId: string): WikiChangeDraft {
    const path = resolveWikiPath(this.root, join(".lume/staging", draftId, "draft.json"));
    if (!existsSync(path)) throw new Error("Wiki draft 不存在或已使用");
    const draft = JSON.parse(readFileSync(path, "utf8")) as WikiChangeDraft;
    if (Date.parse(draft.expiresAt) <= Date.now()) {
      this.cancelDraft(draftId);
      throw new Error("Wiki draft 已过期");
    }
    return draft;
  }

  cancelDraft(draftId: string): void {
    const path = resolveWikiPath(this.root, join(".lume/staging", draftId));
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }

  getProposalSummary(draftId: string): WikiProposalSummaryV1 {
    return createWikiProposalSummary(this.loadDraft(draftId));
  }

  getDraftStatus(draftId: string): WikiDraftStatus {
    if (this.listPending().some((item) => item.draft.id === draftId)) {
      return { draftId, state: "pending_review" };
    }
    const operationsDir = ensureWikiDirectory(this.root, ".lume/operations");
    const applied = readdirSync(operationsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => normalizeBatch(JSON.parse(readFileSync(resolveWikiPath(this.root, join(".lume/operations", name)), "utf8")) as WikiBatch))
      .some((batch) => batch.draftId === draftId && (batch.state === "committed" || batch.state === "undone"));
    if (applied) return { draftId, state: "applied" };
    const stagedDraftPath = resolveWikiPath(this.root, join(".lume/staging", draftId, "draft.json"));
    return { draftId, state: existsSync(stagedDraftPath) ? "pending" : "unavailable" };
  }

  listPending(): WikiPendingReview[] {
    const dir = ensureWikiDirectory(this.root, ".lume/pending");
    return readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(resolveWikiPath(this.root, join(".lume/pending", name)), "utf8")) as WikiPendingReview);
  }

  listPendingSummaries(): WikiPendingReviewSummary[] {
    return this.listPending().map((pending) => ({
      id: pending.id,
      draft: createWikiProposalSummary(pending.draft),
      createdAt: pending.createdAt,
      reason: pending.reason,
      ...(pending.requiresRegeneration ? { requiresRegeneration: true } : {}),
    }));
  }

  listBatches(limit = 30): WikiBatch[] {
    const dir = ensureWikiDirectory(this.root, ".lume/operations");
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => normalizeBatch(JSON.parse(readFileSync(resolveWikiPath(this.root, join(".lume/operations", name)), "utf8")) as WikiBatch))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  reconcileExternalOwnership(): string[] {
    const pages = this.markdown.listPages(false);
    const candidates = pages.map((page) => ({ page, result: promoteExternallyEditedBlocks(page.body) }))
      .filter(({ result }) => result.changed || result.ambiguous);
    if (candidates.length === 0) return [];
    return this.withLock((lock) => candidates.flatMap(({ page, result }) => {
      this.assertFence(lock);
      const current = this.markdown.readRelative(page.path!);
      if (current.hash !== page.hash) return [];
      if (result.ambiguous) {
        this.markdown.markProtected(page.id, "外部编辑破坏 ownership marker，页面已保护");
        this.appendSecurityAudit({ event: "external_edit_protected", result: "protected", rejectionCode: "WIKI_OWNERSHIP_AMBIGUOUS" });
        return [page.id];
      }
      const markdown = serializeWikiPage({ ...current.frontmatter, updated: new Date().toISOString(), revision: current.revision + 1 }, result.body);
      this.markdown.atomicReplace(current.path!, markdown);
      this.appendSecurityAudit({ event: "external_edit_promoted", result: "promoted" });
      return [page.id];
    }));
  }

  privacyArtifacts(sourceIds: string[], pageIds: string[]): { stagingDraftIds: string[]; snapshotBatchIds: string[] } {
    const selectedSources = new Set(sourceIds);
    const selectedPages = new Set(pageIds);
    const stagingRoot = ensureWikiDirectory(this.root, ".lume/staging");
    const stagingDraftIds = readdirSync(stagingRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
      const path = resolveWikiPath(this.root, join(".lume/staging", entry.name, "draft.json"));
      if (!existsSync(path)) return [];
      const draft = JSON.parse(readFileSync(path, "utf8")) as WikiChangeDraft;
      const touchesSource = draft.sources.some((source) => selectedSources.has(source.manifest.id))
        || draft.privacyPurgeSourceIds?.some((sourceId) => selectedSources.has(sourceId));
      const touchesPage = draft.operations.some((operation) => selectedPages.has(operation.pageId));
      return touchesSource || touchesPage ? [draft.id] : [];
    });
    const snapshotBatchIds = this.listBatches(Number.MAX_SAFE_INTEGER)
      .filter((batch) => batch.affectedPageIds.some((pageId) => selectedPages.has(pageId)))
      .map((batch) => batch.id);
    return { stagingDraftIds, snapshotBatchIds };
  }

  applyDraftPrivileged(input: WikiApplyDraftCommandInput, actor = "desktop_owner"): WikiBatch | WikiPendingReview {
    const draft = this.loadDraft(input.draftId);
    const summary = createWikiProposalSummary(draft);
    if (summary.revision !== input.expectedRevision || !constantEqual(summary.diffHash, input.diffHash)) {
      this.appendSecurityAudit({ event: "apply_rejected", draftId: draft.id, creator: draft.creator, diffHash: input.diffHash, result: "rejected", rejectionCode: "WIKI_DRAFT_SUMMARY_MISMATCH" });
      throw new Error("WIKI_DRAFT_SUMMARY_MISMATCH: 草案 revision 或 diffHash 已变化");
    }
    return this.applyDraft({ draftId: draft.id, expectedRevision: draft.revision, nonce: draft.nonce }, actor);
  }

  resolvePendingPrivileged(input: WikiResolvePendingCommandInput, actor = "desktop_owner"): WikiBatch | { rejected: true } {
    const pending = this.readPending(input.pendingId);
    const summary = createWikiProposalSummary(pending.draft);
    if (summary.revision !== input.expectedRevision || !constantEqual(summary.diffHash, input.diffHash)) {
      throw new Error("WIKI_PENDING_SUMMARY_MISMATCH: 待审核项 revision 或 diffHash 已变化");
    }
    return this.resolvePending(input.pendingId, input.action, actor);
  }

  getUndoSummary(batchId: string): WikiUndoSummaryV1 {
    const batch = this.readBatch(batchId);
    if (batch.state !== "committed") throw new Error("只有已提交批次可撤销");
    if (batch.irreversible) throw new Error("隐私永久清除批次不可撤销");
    return { schemaVersion: 1, batchId, expectedBatchRevision: batch.revision, expectedCurrentStateHash: this.currentBatchStateHash(batch) };
  }

  undoPrivileged(input: WikiUndoBatchCommandInput, actor = "desktop_owner"): WikiBatch | WikiPendingReview {
    const batch = this.readBatch(input.batchId);
    if (batch.revision !== input.expectedBatchRevision || !constantEqual(this.currentBatchStateHash(batch), input.expectedCurrentStateHash)) {
      throw new Error("WIKI_UNDO_STATE_MISMATCH: 批次或页面状态已变化");
    }
    return this.undo(input.batchId, actor);
  }

  applyDraft(input: WikiConfirmDraftInput, actor = "desktop_owner", allowHighRisk = false): WikiBatch | WikiPendingReview {
    const draft = this.loadDraft(input.draftId);
    if (draft.revision !== input.expectedRevision || !constantEqual(draft.nonce, input.nonce) || this.nonceWasUsed(draft.nonce)) {
      this.appendSecurityAudit({ event: "apply_rejected", draftId: draft.id, creator: draft.creator, result: "rejected", rejectionCode: "WIKI_DRAFT_CONFIRMATION_INVALID" });
      throw new Error("Wiki draft revision 或确认 nonce 无效");
    }
    if (draft.risk === "high" && !allowHighRisk) {
      const pending: WikiPendingReview = { id: randomUUID(), draft, createdAt: new Date().toISOString(), reason: draft.riskReasons.join("；") };
      writeFileSync(resolveWikiPath(this.root, join(".lume/pending", `${pending.id}.json`)), JSON.stringify(pending, null, 2), { flag: "wx" });
      this.markNonceUsed(draft.nonce);
      this.appendSecurityAudit({ event: "draft_pending_review", draftId: draft.id, creator: draft.creator, diffHash: createWikiProposalSummary(draft).diffHash, result: "pending_review" });
      return pending;
    }

    return this.withLock((lock) => this.commit(draft, actor, lock));
  }

  resolvePending(id: string, action: "accept" | "reject", actor = "desktop_owner"): WikiBatch | { rejected: true } {
    const path = resolveWikiPath(this.root, join(".lume/pending", `${id}.json`));
    if (!existsSync(path)) throw new Error("待审核项不存在");
    const pending = JSON.parse(readFileSync(path, "utf8")) as WikiPendingReview;
    if (action === "reject") {
      rmSync(path);
      this.cancelDraft(pending.draft.id);
      this.appendSecurityAudit({ event: "pending_resolved", draftId: pending.draft.id, creator: pending.draft.creator, diffHash: createWikiProposalSummary(pending.draft).diffHash, result: "rejected" });
      return { rejected: true };
    }
    if (pending.requiresRegeneration) throw new Error("页面已被外部修改，请重新编辑并生成新的确认草案");
    const result = this.withLock((lock) => this.commit(pending.draft, actor, lock));
    rmSync(path, { force: true });
    this.appendSecurityAudit({ event: "pending_resolved", draftId: pending.draft.id, creator: pending.draft.creator, diffHash: createWikiProposalSummary(pending.draft).diffHash, result: "accepted" });
    return result;
  }

  undo(batchId: string, actor = "desktop_owner"): WikiBatch | WikiPendingReview {
    const batch = this.readBatch(batchId);
    if (batch.state !== "committed") throw new Error("只有已提交批次可撤销");
    if (batch.irreversible) throw new Error("隐私永久清除批次不可撤销");
    const operations = batch.diffs.map((diff) => {
      const current = this.markdown.hashRelative(diff.path);
      const snapshot = resolveWikiPath(this.root, join(".lume/snapshots", batch.id, sha256(diff.path), "before"));
      const targetRelativePath = diff.previousPath ?? diff.path;
      return {
        kind: diff.beforeHash === null ? "delete" as const : diff.previousPath ? "move" as const : "update" as const,
        pageId: diff.pageId,
        beforeHash: current,
        targetRelativePath,
        ...(diff.previousPath ? { previousRelativePath: diff.path } : {}),
        ...(diff.beforeHash !== null ? { markdown: readFileSync(snapshot, "utf8") } : {}),
        ...(current !== diff.afterHash ? { contentMutation: { kind: "replace_page" as const } } : {}),
      };
    });
    const stale = batch.diffs.some((diff) => this.markdown.hashRelative(diff.path) !== diff.afterHash);
    const draft = this.stageDraft({
      origin: "undo",
      undoOfBatchId: batchId,
      risk: stale ? "high" : "low",
      riskReasons: stale ? ["页面在原批次后已变化，逆向草案需要审核"] : [],
      title: `撤销 ${batchId}`,
      operations,
      sources: [],
      diffs: batch.diffs.map((diff) => ({
        pageId: diff.pageId,
        path: diff.previousPath ?? diff.path,
        ...(diff.previousPath ? { previousPath: diff.path } : {}),
        beforeHash: this.markdown.hashRelative(diff.path),
        afterHash: diff.beforeHash,
        preview: `撤销 ${diff.path}`,
      })),
      pageVisibilityWorkspaceIds: [],
      sourceGrantWorkspaceIds: []
    });
    return this.applyDraft({ draftId: draft.id, expectedRevision: draft.revision, nonce: draft.nonce }, actor);
  }

  recoverInterrupted(): string[] {
    const dir = ensureWikiDirectory(this.root, ".lume/operations");
    const interrupted = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => normalizeBatch(JSON.parse(readFileSync(resolveWikiPath(this.root, join(".lume/operations", name)), "utf8")) as WikiBatch))
      .filter((batch) => batch.state === "applying");
    if (interrupted.length === 0) return [];
    return this.withLock((lock) => interrupted.flatMap((batch) => this.recoverBatch(batch, lock) ? [batch.id] : []));
  }

  private commit(draft: WikiChangeDraft, actor: string, lock: WikiWriterLock): WikiBatch {
    for (const operation of draft.operations) {
      const current = this.markdown.hashRelative(operation.previousRelativePath ?? operation.targetRelativePath);
      if (current !== operation.beforeHash) throw new Error(`Wiki stale beforeHash: ${operation.targetRelativePath}`);
    }
    const batch: WikiBatch = {
      id: randomUUID(), draftId: draft.id, state: "prepared", fencingToken: lock.fencingToken,
      revision: 1,
      actor, origin: draft.origin, risk: draft.risk, createdAt: new Date().toISOString(), diffs: draft.diffs,
      affectedPageIds: draft.operations.map((operation) => operation.pageId),
      ...(draft.privacyPurgeSourceIds?.length ? { irreversible: true } : {})
    };
    this.writeBatch(batch, lock);
    batch.state = "applying";
    batch.revision += 1;
    this.writeBatch(batch, lock);
    try {
      this.commitSources(draft, actor, lock);
      for (const operation of draft.operations) {
        this.applyOperation(batch, operation, lock);
      }
      if (draft.privacyPurgeSourceIds?.length) this.commitPrivacyPurge(draft, batch);
      batch.state = "committed";
      batch.revision += 1;
      batch.committedAt = new Date().toISOString();
      this.writeBatch(batch, lock);
      if (draft.undoOfBatchId) {
        const original = this.readBatch(draft.undoOfBatchId);
        if (original.state !== "committed") throw new Error("原 Wiki 批次已不可撤销");
        original.state = "undone";
        original.revision += 1;
        this.writeBatch(original, lock);
      }
      this.consumeNonce(draft);
      this.appendSecurityAudit({ event: "draft_committed", draftId: draft.id, creator: draft.creator, diffHash: createWikiProposalSummary(draft).diffHash, result: "committed" });
      this.appendAudit(batch);
      return batch;
    } catch (error) {
      batch.error = error instanceof Error ? error.message : String(error);
      batch.revision += 1;
      this.writeBatch(batch, lock);
      throw error;
    }
  }

  private consumeNonce(draft: WikiChangeDraft): void {
    this.markNonceUsed(draft.nonce);
    this.cancelDraft(draft.id);
  }

  private markNonceUsed(nonce: string): void {
    appendFileSync(resolveWikiPath(this.root, ".lume/operations/used-nonces"), `${sha256(nonce)}\n`, "utf8");
  }

  private nonceWasUsed(nonce: string): boolean {
    const path = resolveWikiPath(this.root, ".lume/operations/used-nonces");
    return existsSync(path) && readFileSync(path, "utf8").split(/\r?\n/).includes(sha256(nonce));
  }

  private assertDraftQuota(
    input: Pick<WikiChangeDraft, "origin" | "operations"> & { payloads?: Record<string, Uint8Array> },
    creator: WikiDraftCreator,
  ): void {
    const markdownBytes = input.operations.reduce(
      (total, operation) => total + (operation.markdown ? Buffer.byteLength(operation.markdown, "utf8") : 0),
      0,
    );
    if (input.origin === "agent" && markdownBytes > MAX_AGENT_DRAFT_MARKDOWN_BYTES) {
      throw new Error(`WIKI_DRAFT_TOO_LARGE: Agent 草案 Markdown 超过 ${MAX_AGENT_DRAFT_MARKDOWN_BYTES} bytes`);
    }

    const stagingRoot = ensureWikiDirectory(this.root, ".lume/staging");
    const staged = readdirSync(stagingRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    if (staged.length >= MAX_PENDING_DRAFTS) {
      throw new Error(`WIKI_DRAFT_GLOBAL_LIMIT: 未决草案已达到 ${MAX_PENDING_DRAFTS}`);
    }

    const quotaIdentity = creator.threadId ?? creator.subjectId;
    const matching = staged.filter((entry) => {
      const draftPath = resolveWikiPath(this.root, join(".lume/staging", entry.name, "draft.json"));
      if (!existsSync(draftPath)) return false;
      try {
        const existing = JSON.parse(readFileSync(draftPath, "utf8")) as Partial<WikiChangeDraft>;
        return (existing.creator?.threadId ?? existing.creator?.subjectId) === quotaIdentity;
      } catch {
        return false;
      }
    }).length;
    if (input.origin === "agent" && matching >= MAX_PENDING_DRAFTS_PER_THREAD) {
      throw new Error(`WIKI_DRAFT_THREAD_LIMIT: 当前线程未决草案已达到 ${MAX_PENDING_DRAFTS_PER_THREAD}`);
    }

    const payloadBytes = Object.values(input.payloads ?? {}).reduce((total, payload) => total + payload.byteLength, 0);
    const projectedBytes = directorySize(stagingRoot) + markdownBytes + payloadBytes;
    if (projectedBytes > MAX_STAGING_BYTES) {
      throw new Error(`WIKI_DRAFT_STAGING_LIMIT: staging 将超过 ${MAX_STAGING_BYTES} bytes`);
    }
  }

  private appendSecurityAudit(event: {
    event: string;
    draftId?: string;
    creator?: WikiDraftCreator;
    diffHash?: string;
    result: string;
    rejectionCode?: string;
  }): void {
    appendFileSync(
      resolveWikiPath(this.root, ".lume/operations/security-audit.jsonl"),
      `${JSON.stringify({ ...event, createdAt: new Date().toISOString() })}\n`,
      "utf8",
    );
  }

  private withLock<T>(run: (lock: WikiWriterLock) => T): T {
    const lockPath = resolveWikiPath(this.root, ".lume/operations/writer.lock");
    if (existsSync(lockPath)) {
      const current = JSON.parse(readFileSync(lockPath, "utf8")) as WikiWriterLock;
      if (processIsAlive(current.ownerPid)) throw new Error("Wiki 正由另一个存活 writer 修改");
      rmSync(lockPath);
    }
    const tokenPath = resolveWikiPath(this.root, ".lume/operations/fencing-token");
    const fencingToken = existsSync(tokenPath) ? Number(readFileSync(tokenPath, "utf8")) + 1 : 1;
    writeFileSync(tokenPath, String(fencingToken), "utf8");
    const lock: WikiWriterLock = { ownerPid: process.pid, ownerId: randomUUID(), fencingToken, heartbeatAt: new Date().toISOString() };
    writeFileSync(lockPath, JSON.stringify(lock), { flag: "wx" });
    const heartbeat = setInterval(() => {
      if (!existsSync(lockPath)) return;
      const current = JSON.parse(readFileSync(lockPath, "utf8")) as WikiWriterLock;
      if (current.ownerId === lock.ownerId && current.fencingToken === lock.fencingToken) {
        lock.heartbeatAt = new Date().toISOString();
        writeFileSync(lockPath, JSON.stringify(lock), "utf8");
      }
    }, 1_000);
    heartbeat.unref();
    try { return run(lock); }
    finally {
      clearInterval(heartbeat);
      if (existsSync(lockPath)) {
        const current = JSON.parse(readFileSync(lockPath, "utf8")) as WikiWriterLock;
        if (current.ownerId === lock.ownerId && current.fencingToken === lock.fencingToken) rmSync(lockPath);
      }
    }
  }

  private assertFence(lock: WikiWriterLock): void {
    const path = resolveWikiPath(this.root, ".lume/operations/writer.lock");
    if (!existsSync(path)) throw new Error("Wiki writer 丢失 lock");
    const current = JSON.parse(readFileSync(path, "utf8")) as WikiWriterLock;
    if (current.ownerId !== lock.ownerId || current.fencingToken !== lock.fencingToken) throw new Error("Wiki writer fencing token 已失效");
  }

  private writeBatch(batch: WikiBatch, lock: WikiWriterLock): void {
    this.assertFence(lock);
    const path = resolveWikiPath(this.root, join(".lume/operations", `${batch.id}.json`));
    const temp = resolveWikiPath(this.root, join(".lume/operations", `${batch.id}.${randomUUID()}.tmp`));
    writeFileSync(temp, JSON.stringify(batch, null, 2), { flag: "wx" });
    renameSync(temp, path);
  }

  private readBatch(id: string): WikiBatch {
    return normalizeBatch(JSON.parse(readFileSync(resolveWikiPath(this.root, join(".lume/operations", `${id}.json`)), "utf8")) as WikiBatch);
  }

  private readPending(id: string): WikiPendingReview {
    const path = resolveWikiPath(this.root, join(".lume/pending", `${id}.json`));
    if (!existsSync(path)) throw new Error("待审核项不存在");
    return JSON.parse(readFileSync(path, "utf8")) as WikiPendingReview;
  }

  private currentBatchStateHash(batch: WikiBatch): string {
    return sha256(JSON.stringify(batch.diffs
      .map((diff) => ({ pageId: diff.pageId, path: diff.path, currentHash: this.markdown.hashRelative(diff.path) }))
      .sort((left, right) => left.pageId.localeCompare(right.pageId) || left.path.localeCompare(right.path))));
  }

  private appendAudit(batch: WikiBatch): void {
    appendFileSync(resolveWikiPath(this.root, ".lume/operations/audit.jsonl"), `${JSON.stringify({ batchId: batch.id, actor: batch.actor, origin: batch.origin, risk: batch.risk, affectedPageIds: batch.affectedPageIds, result: batch.state, createdAt: batch.createdAt })}\n`, "utf8");
  }

  private recoverBatch(batch: WikiBatch, lock: WikiWriterLock): boolean {
    const draftPath = resolveWikiPath(this.root, join(".lume/staging", batch.draftId, "draft.json"));
    if (!existsSync(draftPath)) {
      batch.state = "failed";
      batch.error = "中断恢复失败：staging draft 缺失";
      batch.revision += 1;
      this.writeBatch(batch, lock);
      return false;
    }
    const draft = JSON.parse(readFileSync(draftPath, "utf8")) as WikiChangeDraft;
    const conflict = draft.operations.find((operation) => this.operationState(batch, operation) === "conflict");
    if (conflict) {
      const reason = `恢复停止：${conflict.targetRelativePath} 出现第三方 hash`;
      this.markRecoveryConflict(batch, draft, conflict, reason, lock);
      return false;
    }
    try {
      this.commitSources(draft, batch.actor, lock);
      for (const operation of draft.operations) {
        if (this.operationState(batch, operation) !== "done") this.applyOperation(batch, operation, lock);
      }
      batch.state = "committed";
      batch.revision += 1;
      batch.error = undefined;
      batch.committedAt = new Date().toISOString();
      this.writeBatch(batch, lock);
      this.consumeNonce(draft);
      this.appendAudit(batch);
      this.appendSecurityAudit({ event: "draft_recovered", draftId: draft.id, creator: draft.creator, diffHash: createWikiProposalSummary(draft).diffHash, result: "committed" });
      return true;
    } catch (error) {
      batch.error = error instanceof Error ? error.message : String(error);
      batch.revision += 1;
      this.writeBatch(batch, lock);
      throw error;
    }
  }

  private commitSources(draft: WikiChangeDraft, actor: string, lock: WikiWriterLock): void {
    for (const source of draft.sources) {
      this.assertFence(lock);
      const payload = source.payloadRelativePath ? readFileSync(resolveWikiPath(this.root, source.payloadRelativePath)) : undefined;
      this.sources.commit(source.manifest, payload);
      for (const workspaceId of source.grants) {
        if (!this.acl.hasGrant(source.manifest.id, workspaceId)) this.acl.append(source.manifest.id, workspaceId, "grant", actor);
      }
    }
  }

  private applyOperation(batch: WikiBatch, operation: WikiDraftOperation, lock: WikiWriterLock): void {
    this.assertFence(lock);
    const diff = batch.diffs.find((item) => item.path === operation.targetRelativePath);
    if (!diff) throw new Error(`Wiki batch 缺少 diff: ${operation.targetRelativePath}`);
    const state = this.operationState(batch, operation);
    if (state === "done") return;
    if (state === "conflict") throw new Error(`Wiki recovery conflict: ${operation.targetRelativePath}`);

    const currentPath = operation.previousRelativePath ?? operation.targetRelativePath;
    const currentAbsolute = resolveWikiPath(this.root, currentPath);
    const snapshotDir = ensureWikiDirectory(this.root, join(".lume/snapshots", batch.id, sha256(operation.targetRelativePath)));
    const beforeSnapshot = join(snapshotDir, "before");
    if (existsSync(currentAbsolute)) this.writeSnapshot(beforeSnapshot, readFileSync(currentAbsolute), operation.beforeHash);

    if (operation.kind === "delete") {
      this.markdown.remove(currentPath);
    } else {
      if (!operation.markdown || sha256(operation.markdown) !== diff.afterHash) throw new Error("Wiki operation markdown 与 afterHash 不一致");
      if (operation.previousRelativePath && operation.previousRelativePath !== operation.targetRelativePath && existsSync(currentAbsolute)) {
        this.markdown.remove(operation.previousRelativePath);
      }
      this.markdown.atomicReplace(operation.targetRelativePath, operation.markdown);
      this.writeSnapshot(join(snapshotDir, "after"), Buffer.from(operation.markdown), diff.afterHash);
    }
    if (this.markdown.hashRelative(operation.targetRelativePath) !== diff.afterHash) throw new Error(`Wiki replace 后 hash 校验失败: ${operation.targetRelativePath}`);
  }

  private operationState(batch: WikiBatch, operation: WikiDraftOperation): "done" | "pending" | "conflict" {
    const diff = batch.diffs.find((item) => item.path === operation.targetRelativePath);
    if (!diff) return "conflict";
    const targetHash = this.markdown.hashRelative(operation.targetRelativePath);
    if (targetHash === diff.afterHash) return "done";
    const currentPath = operation.previousRelativePath ?? operation.targetRelativePath;
    if (this.markdown.hashRelative(currentPath) === operation.beforeHash) return "pending";
    if (operation.previousRelativePath && targetHash === null && this.markdown.hashRelative(currentPath) === null) {
      const snapshot = resolveWikiPath(this.root, join(".lume/snapshots", batch.id, sha256(operation.targetRelativePath), "before"));
      if (existsSync(snapshot) && sha256(readFileSync(snapshot)) === operation.beforeHash) return "pending";
    }
    return "conflict";
  }

  private writeSnapshot(path: string, content: Uint8Array, expectedHash: string | null): void {
    if (expectedHash !== null && sha256(content) !== expectedHash) throw new Error("Wiki snapshot hash 不匹配");
    if (existsSync(path)) {
      if (sha256(readFileSync(path)) !== sha256(content)) throw new Error("Wiki snapshot 已存在但内容不一致");
      return;
    }
    writeFileSync(path, content, { flag: "wx" });
  }

  private commitPrivacyPurge(draft: WikiChangeDraft, batch: WikiBatch): void {
    const sourceIds = [...new Set(draft.privacyPurgeSourceIds ?? [])];
    for (const sourceId of sourceIds) this.sources.purge(sourceId, batch.actor);
    const artifacts = this.privacyArtifacts(sourceIds, batch.affectedPageIds);
    for (const draftId of artifacts.stagingDraftIds) {
      if (draftId !== draft.id) rmSync(resolveWikiPath(this.root, join(".lume/staging", draftId)), { recursive: true, force: true });
    }
    for (const batchId of artifacts.snapshotBatchIds) rmSync(resolveWikiPath(this.root, join(".lume/snapshots", batchId)), { recursive: true, force: true });
    for (const pending of this.listPending()) {
      if (pending.draft.id === draft.id) continue;
      if (pending.draft.sources.some((source) => sourceIds.includes(source.manifest.id))
        || pending.draft.operations.some((operation) => batch.affectedPageIds.includes(operation.pageId))) {
        rmSync(resolveWikiPath(this.root, join(".lume/pending", `${pending.id}.json`)), { force: true });
      }
    }
    this.appendSecurityAudit({ event: "privacy_purge_committed", draftId: draft.id, creator: draft.creator, diffHash: createWikiProposalSummary(draft).diffHash, result: "committed" });
  }

  private markRecoveryConflict(batch: WikiBatch, draft: WikiChangeDraft, operation: WikiDraftOperation, reason: string, lock: WikiWriterLock): void {
    this.markdown.markProtected(operation.pageId, reason);
    const pending: WikiPendingReview = {
      id: randomUUID(),
      draft: { ...draft, risk: "high", riskReasons: [...new Set([...draft.riskReasons, reason])] },
      createdAt: new Date().toISOString(),
      reason,
      requiresRegeneration: true,
    };
    writeFileSync(resolveWikiPath(this.root, join(".lume/pending", `${pending.id}.json`)), JSON.stringify(pending, null, 2), { flag: "wx" });
    batch.state = "failed";
    batch.error = reason;
    batch.revision += 1;
    this.writeBatch(batch, lock);
  }
}

function constantEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function defaultDraftCreator(origin: WikiChangeDraft["origin"]): WikiDraftCreator {
  return {
    subjectId: origin === "agent" ? "local-desktop-agent" : "local-owner",
    profile: origin === "agent" ? "ordinary-agent" : origin === "undo" ? "system" : "owner-ui",
    scope: { kind: "all" },
    channel: origin === "agent" ? "agent" : origin === "import" ? "import" : origin === "undo" ? "undo" : "ui",
  };
}

function directorySize(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    const stat = lstatSync(child);
    if (stat.isSymbolicLink()) throw new Error("WIKI_DRAFT_STAGING_SYMLINK: staging 中不允许符号链接");
    total += stat.isDirectory() ? directorySize(child) : stat.size;
  }
  return total;
}

function normalizeBatch(batch: WikiBatch): WikiBatch {
  return { ...batch, revision: Number.isInteger(batch.revision) && batch.revision > 0 ? batch.revision : 1 };
}
