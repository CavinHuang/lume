import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WikiBatch, WikiChangeDraft, WikiConfirmDraftInput, WikiDraftOperation, WikiPendingReview } from "@lume/shared";
import { WikiAclStore } from "./acl-store";
import { sha256, WikiMarkdownStore } from "./markdown-store";
import { ensureWikiDirectory, processIsAlive, resolveWikiPath } from "./path-security";
import { WikiSourceStore } from "./source-store";

interface WikiWriterLock {
  ownerPid: number;
  ownerId: string;
  fencingToken: number;
  heartbeatAt: string;
}

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export class WikiMutationCoordinator {
  readonly markdown: WikiMarkdownStore;
  readonly sources: WikiSourceStore;
  readonly acl: WikiAclStore;

  constructor(readonly root: string) {
    this.markdown = new WikiMarkdownStore(root);
    this.sources = new WikiSourceStore(root);
    this.acl = new WikiAclStore(root);
  }

  stageDraft(input: Omit<WikiChangeDraft, "id" | "revision" | "nonce" | "expiresAt"> & { id?: string; payloads?: Record<string, Uint8Array> }): WikiChangeDraft {
    this.markdown.ensureLayout();
    const draftId = input.id ?? randomUUID();
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
      expiresAt: new Date(Date.now() + DRAFT_TTL_MS).toISOString(),
      sources
    };
    writeFileSync(join(directory, "draft.json"), JSON.stringify(draft, null, 2), { encoding: "utf8", flag: "wx" });
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

  listPending(): WikiPendingReview[] {
    const dir = ensureWikiDirectory(this.root, ".lume/pending");
    return readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(resolveWikiPath(this.root, join(".lume/pending", name)), "utf8")) as WikiPendingReview);
  }

  listBatches(limit = 30): WikiBatch[] {
    const dir = ensureWikiDirectory(this.root, ".lume/operations");
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(resolveWikiPath(this.root, join(".lume/operations", name)), "utf8")) as WikiBatch)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  applyDraft(input: WikiConfirmDraftInput, actor = "desktop_owner", allowHighRisk = false): WikiBatch | WikiPendingReview {
    const draft = this.loadDraft(input.draftId);
    if (draft.revision !== input.expectedRevision || !constantEqual(draft.nonce, input.nonce) || this.nonceWasUsed(draft.nonce)) throw new Error("Wiki draft revision 或确认 nonce 无效");
    if (draft.risk === "high" && !allowHighRisk) {
      const pending: WikiPendingReview = { id: randomUUID(), draft, createdAt: new Date().toISOString(), reason: draft.riskReasons.join("；") };
      writeFileSync(resolveWikiPath(this.root, join(".lume/pending", `${pending.id}.json`)), JSON.stringify(pending, null, 2), { flag: "wx" });
      this.markNonceUsed(draft.nonce);
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
      return { rejected: true };
    }
    if (pending.requiresRegeneration) throw new Error("页面已被外部修改，请重新编辑并生成新的确认草案");
    const result = this.withLock((lock) => this.commit(pending.draft, actor, lock));
    rmSync(path, { force: true });
    return result;
  }

  undo(batchId: string, actor = "desktop_owner"): WikiBatch | WikiPendingReview {
    const batch = this.readBatch(batchId);
    if (batch.state !== "committed") throw new Error("只有已提交批次可撤销");
    const operations = batch.diffs.map((diff) => {
      const current = this.markdown.hashRelative(diff.path);
      if (current !== diff.afterHash) return null;
      const snapshot = resolveWikiPath(this.root, join(".lume/snapshots", batch.id, sha256(diff.path), "before"));
      return {
        kind: diff.beforeHash === null ? "delete" as const : "update" as const,
        pageId: batch.affectedPageIds[0] ?? randomUUID(),
        beforeHash: diff.afterHash,
        targetRelativePath: diff.path,
        ...(diff.beforeHash !== null ? { markdown: readFileSync(snapshot, "utf8") } : {})
      };
    });
    const stale = operations.some((operation) => operation === null);
    const draft = this.stageDraft({
      origin: "undo",
      risk: stale ? "high" : "low",
      riskReasons: stale ? ["页面在原批次后已变化，逆向草案需要审核"] : [],
      title: `撤销 ${batchId}`,
      operations: operations.filter(Boolean) as NonNullable<(typeof operations)[number]>[],
      sources: [],
      diffs: batch.diffs.map((diff) => ({ ...diff, beforeHash: diff.afterHash, afterHash: diff.beforeHash })),
      pageVisibilityWorkspaceIds: [],
      sourceGrantWorkspaceIds: []
    });
    return this.applyDraft({ draftId: draft.id, expectedRevision: draft.revision, nonce: draft.nonce }, actor);
  }

  recoverInterrupted(): string[] {
    const dir = ensureWikiDirectory(this.root, ".lume/operations");
    const interrupted = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(resolveWikiPath(this.root, join(".lume/operations", name)), "utf8")) as WikiBatch)
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
      actor, origin: draft.origin, risk: draft.risk, createdAt: new Date().toISOString(), diffs: draft.diffs,
      affectedPageIds: draft.operations.map((operation) => operation.pageId)
    };
    this.writeBatch(batch, lock);
    batch.state = "applying";
    this.writeBatch(batch, lock);
    try {
      this.commitSources(draft, actor, lock);
      for (const operation of draft.operations) {
        this.applyOperation(batch, operation, lock);
      }
      batch.state = "committed";
      batch.committedAt = new Date().toISOString();
      this.writeBatch(batch, lock);
      this.consumeNonce(draft);
      this.appendAudit(batch);
      return batch;
    } catch (error) {
      batch.error = error instanceof Error ? error.message : String(error);
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
    return JSON.parse(readFileSync(resolveWikiPath(this.root, join(".lume/operations", `${id}.json`)), "utf8")) as WikiBatch;
  }

  private appendAudit(batch: WikiBatch): void {
    appendFileSync(resolveWikiPath(this.root, ".lume/operations/audit.jsonl"), `${JSON.stringify({ batchId: batch.id, actor: batch.actor, origin: batch.origin, risk: batch.risk, affectedPageIds: batch.affectedPageIds, result: batch.state, createdAt: batch.createdAt })}\n`, "utf8");
  }

  private recoverBatch(batch: WikiBatch, lock: WikiWriterLock): boolean {
    const draftPath = resolveWikiPath(this.root, join(".lume/staging", batch.draftId, "draft.json"));
    if (!existsSync(draftPath)) {
      batch.state = "failed";
      batch.error = "中断恢复失败：staging draft 缺失";
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
      batch.error = undefined;
      batch.committedAt = new Date().toISOString();
      this.writeBatch(batch, lock);
      this.consumeNonce(draft);
      this.appendAudit(batch);
      return true;
    } catch (error) {
      batch.error = error instanceof Error ? error.message : String(error);
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
    this.writeBatch(batch, lock);
  }
}

function constantEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
