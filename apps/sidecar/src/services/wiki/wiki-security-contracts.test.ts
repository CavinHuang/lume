import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyWikiBlockPatches,
  createManagedWikiBody,
  createWikiPageMarkdown,
  parseBlockRegions,
  parseWikiPage,
  promoteEditedWikiBlocksToUser,
  removePurgedSourceBlocks,
  sha256,
} from "./markdown-store";
import { WikiMutationCoordinator } from "./mutation-coordinator";
import { WikiPrivilegedCredentialGate } from "./privileged-auth";
import { createWikiProposalSummary } from "./proposal-summary";
import { resolveWikiPath } from "./path-security";

const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "lume-wiki-security-"));
  roots.push(value);
  return value;
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("Wiki proposal security contracts", () => {
  test("keeps ownership hashes valid, patches only Agent blocks, and promotes user edits", () => {
    const body = createManagedWikiBody({ summary: "原摘要", known: "事实" });
    const regions = parseBlockRegions(body);
    expect(regions).toHaveLength(5);
    expect(regions.every((region) => sha256(region.content) === region.content_hash)).toBeTrue();

    const agent = regions[0]!;
    const patched = applyWikiBlockPatches(body, [{ blockId: agent.block_id, expectedContentHash: agent.content_hash, action: "update", content: "# 摘要\n\n新摘要" }]);
    expect(parseBlockRegions(patched)[0]?.content).toContain("新摘要");

    const user = regions.find((region) => region.owner === "user")!;
    expect(() => applyWikiBlockPatches(body, [{ blockId: user.block_id, expectedContentHash: user.content_hash, action: "delete" }])).toThrow("WIKI_USER_BLOCK_PROTECTED");

    const edited = body.replace("原摘要", "用户改写的摘要");
    const promoted = promoteEditedWikiBlocksToUser(body, edited);
    expect(promoted.ambiguous).toBeFalse();
    const promotedRegion = parseBlockRegions(promoted.body).find((region) => region.block_id === agent.block_id)!;
    expect(promotedRegion.owner).toBe("user");
    expect(sha256(promotedRegion.content)).toBe(promotedRegion.content_hash);
  });

  test("returns a nonce-free canonical summary and rejects a substituted diff hash", () => {
    const vault = root();
    const coordinator = new WikiMutationCoordinator(vault);
    const markdown = createWikiPageMarkdown({ type: "topic", title: "安全摘要", primaryWorkspace: null });
    const page = parseWikiPage(markdown);
    const target = `inbox/${page.fileKey}.md`;
    const draft = coordinator.stageDraft({
      origin: "agent",
      creator: { subjectId: "agent", threadId: "thread-1", profile: "ask-wiki", scope: { kind: "inbox" }, channel: "agent" },
      risk: "low", riskReasons: [], title: "创建安全摘要",
      operations: [{ kind: "create", pageId: page.id, beforeHash: null, targetRelativePath: target, markdown }],
      sources: [],
      diffs: [{ pageId: page.id, path: target, beforeHash: null, afterHash: page.hash, preview: "创建" }],
      pageVisibilityWorkspaceIds: [], sourceGrantWorkspaceIds: [],
    });
    const summary = createWikiProposalSummary(draft);
    expect(JSON.stringify(summary)).not.toContain(draft.nonce);
    expect(() => coordinator.applyDraftPrivileged({ draftId: draft.id, expectedRevision: draft.revision, diffHash: "0".repeat(64) })).toThrow("WIKI_DRAFT_SUMMARY_MISMATCH");
    const result = coordinator.applyDraftPrivileged({ draftId: draft.id, expectedRevision: summary.revision, diffHash: summary.diffHash });
    expect("state" in result && result.state).toBe("committed");
  });

  test("enforces Agent draft size before writing staging and records a stable rejection", () => {
    const vault = root();
    const coordinator = new WikiMutationCoordinator(vault);
    const markdown = "x".repeat(2 * 1024 * 1024 + 1);
    expect(() => coordinator.stageDraft({
      origin: "agent",
      creator: { subjectId: "agent", threadId: "thread-limit", profile: "ordinary-agent", scope: { kind: "inbox" }, channel: "agent" },
      risk: "low", riskReasons: [], title: "oversized",
      operations: [{ kind: "create", pageId: "11111111-1111-4111-8111-111111111111", beforeHash: null, targetRelativePath: "inbox/oversized.md", markdown }],
      sources: [], diffs: [{ pageId: "11111111-1111-4111-8111-111111111111", path: "inbox/oversized.md", beforeHash: null, afterHash: sha256(markdown), preview: "oversized" }],
      pageVisibilityWorkspaceIds: [], sourceGrantWorkspaceIds: [],
    })).toThrow("WIKI_DRAFT_TOO_LARGE");
    expect(existsSync(resolveWikiPath(vault, ".lume/staging"))).toBeTrue();
    expect(readFileSync(resolveWikiPath(vault, ".lume/operations/security-audit.jsonl"), "utf8")).toContain("WIKI_DRAFT_TOO_LARGE");
  });

  test("rotates in a fresh process gate and uses constant credential validation", () => {
    const gate = new WikiPrivilegedCredentialGate();
    const credential = randomBytes(32).toString("base64url");
    expect(() => gate.assert(credential)).toThrow("WIKI_PRIVILEGED_UNAVAILABLE");
    gate.install(credential);
    expect(() => gate.assert("x".repeat(43))).toThrow("WIKI_PRIVILEGED_DENIED");
    expect(() => gate.assert(credential)).not.toThrow();
    gate.install(randomBytes(32).toString("base64url"));
    expect(() => gate.assert(credential)).not.toThrow();

    const restarted = new WikiPrivilegedCredentialGate();
    const replacement = randomBytes(32).toString("base64url");
    restarted.install(replacement);
    expect(() => restarted.assert(credential)).toThrow("WIKI_PRIVILEGED_DENIED");
    expect(() => restarted.assert(replacement)).not.toThrow();
  });

  test("keeps formal mutations out of general Wiki RPC and authenticates every privileged call", () => {
    const handlers = readFileSync(new URL("../../rpc/wiki-handlers.ts", import.meta.url), "utf8");
    expect(handlers).not.toContain("[WIKI_IPC_CHANNELS.APPLY_DRAFT]");
    expect(handlers).not.toContain("[WIKI_IPC_CHANNELS.RESOLVE_PENDING]");
    expect(handlers).not.toContain("[WIKI_IPC_CHANNELS.UNDO_BATCH]");
    expect(handlers.match(/privilegedRequest\(params,/g)).toHaveLength(5);
    expect(handlers).toContain("assertWikiPrivilegedCredential(input.credential)");
  });

  test("keeps a pending draft recoverable across a sidecar coordinator restart", () => {
    const vault = root(); const first = new WikiMutationCoordinator(vault);
    const markdown = createWikiPageMarkdown({ type: "topic", title: "重启恢复", primaryWorkspace: null });
    const page = parseWikiPage(markdown); const path = `inbox/${page.fileKey}.md`;
    const draft = first.stageDraft({ origin: "ui", risk: "low", riskReasons: [], title: "重启恢复", operations: [{ kind: "create", pageId: page.id, beforeHash: null, targetRelativePath: path, markdown }], sources: [], diffs: [{ pageId: page.id, path, beforeHash: null, afterHash: page.hash, preview: "创建" }], pageVisibilityWorkspaceIds: [], sourceGrantWorkspaceIds: [] });
    const restarted = new WikiMutationCoordinator(vault);
    const summary = restarted.getProposalSummary(draft.id);
    const result = restarted.applyDraftPrivileged({ draftId: draft.id, expectedRevision: summary.revision, diffHash: summary.diffHash });
    expect("state" in result && result.state).toBe("committed");
  });

  test("undoes every page in a batch and sends stale inverses to pending review", () => {
    const vault = root();
    const coordinator = new WikiMutationCoordinator(vault);
    const markdowns = ["第一页", "第二页"].map((title) => createWikiPageMarkdown({ type: "topic", title, primaryWorkspace: null }));
    const pages = markdowns.map((markdown) => parseWikiPage(markdown));
    const paths = pages.map((page) => `inbox/${page.fileKey}.md`);
    const draft = coordinator.stageDraft({
      origin: "ui", risk: "low", riskReasons: [], title: "创建两页",
      operations: pages.map((page, index) => ({ kind: "create" as const, pageId: page.id, beforeHash: null, targetRelativePath: paths[index]!, markdown: markdowns[index] })),
      sources: [],
      diffs: pages.map((page, index) => ({ pageId: page.id, path: paths[index]!, beforeHash: null, afterHash: page.hash, preview: `创建 ${page.title}` })),
      pageVisibilityWorkspaceIds: [], sourceGrantWorkspaceIds: [],
    });
    const proposal = createWikiProposalSummary(draft);
    const batch = coordinator.applyDraftPrivileged({ draftId: draft.id, expectedRevision: proposal.revision, diffHash: proposal.diffHash });
    if (!("state" in batch) || batch.state !== "committed") throw new Error("fixture batch was not committed");

    const undoSummary = coordinator.getUndoSummary(batch.id);
    const undone = coordinator.undoPrivileged(undoSummary);
    expect("state" in undone && undone.state).toBe("committed");
    expect(paths.every((path) => coordinator.markdown.hashRelative(path) === null)).toBeTrue();

    const replacement = createWikiPageMarkdown({ type: "topic", title: "会被外部编辑", primaryWorkspace: null });
    const replacementPage = parseWikiPage(replacement);
    const replacementPath = `inbox/${replacementPage.fileKey}.md`;
    const replacementDraft = coordinator.stageDraft({
      origin: "ui", risk: "low", riskReasons: [], title: "创建后竞争",
      operations: [{ kind: "create", pageId: replacementPage.id, beforeHash: null, targetRelativePath: replacementPath, markdown: replacement }],
      sources: [], diffs: [{ pageId: replacementPage.id, path: replacementPath, beforeHash: null, afterHash: replacementPage.hash, preview: "创建" }],
      pageVisibilityWorkspaceIds: [], sourceGrantWorkspaceIds: [],
    });
    const replacementSummary = createWikiProposalSummary(replacementDraft);
    const replacementBatch = coordinator.applyDraftPrivileged({ draftId: replacementDraft.id, expectedRevision: replacementSummary.revision, diffHash: replacementSummary.diffHash });
    if (!("state" in replacementBatch) || replacementBatch.state !== "committed") throw new Error("fixture batch was not committed");
    coordinator.markdown.atomicReplace(replacementPath, replacement.replace("会被外部编辑", "Obsidian 已修改"));

    const staleUndo = coordinator.undoPrivileged(coordinator.getUndoSummary(replacementBatch.id));
    expect("draft" in staleUndo).toBeTrue();
    expect("draft" in staleUndo && staleUndo.draft.risk).toBe("high");
    expect(coordinator.markdown.hashRelative(replacementPath)).not.toBeNull();
  });

  test("purges provenance only after pending review and preserves a shared payload", () => {
    const vault = root();
    const coordinator = new WikiMutationCoordinator(vault);
    const payload = new TextEncoder().encode("共享但 provenance 独立");
    const make = () => coordinator.sources.createManifest({
      kind: "text", title: "来源", capture_mode: "snapshotted",
      capture_scope_snapshot: { capturedBy: "desktop_owner" }, locator: {}, media_type: "text/plain", warnings: [], payload,
    });
    const first = make(); const second = make();
    coordinator.sources.commit(first.manifest, first.payload);
    coordinator.sources.commit(second.manifest, second.payload);
    const body = createManagedWikiBody({ known: "仅由来源一支撑", sourceIds: [first.manifest.id] });
    expect(removePurgedSourceBlocks(body, [first.manifest.id])).not.toContain("仅由来源一支撑");

    const draft = coordinator.stageDraft({
      origin: "ui",
      creator: { subjectId: "owner", profile: "owner-ui", scope: { kind: "all" }, channel: "lifecycle" },
      risk: "high", riskReasons: ["永久清除"], title: "清除来源一", operations: [], sources: [], diffs: [],
      pageVisibilityWorkspaceIds: [], sourceGrantWorkspaceIds: [], privacyPurgeSourceIds: [first.manifest.id],
    });
    const summary = createWikiProposalSummary(draft);
    const pending = coordinator.applyDraftPrivileged({ draftId: draft.id, expectedRevision: summary.revision, diffHash: summary.diffHash });
    expect("draft" in pending).toBeTrue();
    expect(coordinator.sources.readManifest(first.manifest.id)).toBeDefined();
    if (!("draft" in pending)) throw new Error("privacy fixture did not enter review");
    const accepted = coordinator.resolvePendingPrivileged({ pendingId: pending.id, action: "accept", expectedRevision: summary.revision, diffHash: summary.diffHash });
    expect("state" in accepted && accepted.state).toBe("committed");
    if (!("state" in accepted)) throw new Error("privacy fixture was rejected");
    expect(accepted.irreversible).toBeTrue();
    expect(() => coordinator.getUndoSummary(accepted.id)).toThrow("不可撤销");
    expect(coordinator.sources.readManifest(first.manifest.id)).toBeUndefined();
    expect(new TextDecoder().decode(coordinator.sources.readPayload(second.manifest.id))).toBe("共享但 provenance 独立");
  });

  test("promotes externally edited Agent blocks to user ownership before the next read", () => {
    const vault = root(); const coordinator = new WikiMutationCoordinator(vault);
    const markdown = createWikiPageMarkdown({ type: "topic", title: "外部编辑", primaryWorkspace: null, body: createManagedWikiBody({ summary: "原始摘要" }) });
    const page = parseWikiPage(markdown); const path = `inbox/${page.fileKey}.md`;
    const draft = coordinator.stageDraft({
      origin: "ui", risk: "low", riskReasons: [], title: "创建",
      operations: [{ kind: "create", pageId: page.id, beforeHash: null, targetRelativePath: path, markdown }], sources: [],
      diffs: [{ pageId: page.id, path, beforeHash: null, afterHash: page.hash, preview: "创建" }], pageVisibilityWorkspaceIds: [], sourceGrantWorkspaceIds: [],
    });
    const summary = createWikiProposalSummary(draft);
    coordinator.applyDraftPrivileged({ draftId: draft.id, expectedRevision: summary.revision, diffHash: summary.diffHash });
    coordinator.markdown.atomicReplace(path, markdown.replace("原始摘要", "用户在 Obsidian 修改"));
    expect(coordinator.reconcileExternalOwnership()).toEqual([page.id]);
    const changed = coordinator.markdown.readById(page.id)!;
    expect(parseBlockRegions(changed.body).find((region) => region.content.includes("用户在 Obsidian 修改"))?.owner).toBe("user");
    expect(changed.protected).toBeFalse();
  });

  test("keeps the embedding cache incremental and rebuilds provenance index rows", () => {
    const source = readFileSync(join(import.meta.dir, "index-service.ts"), "utf8");
    expect(source).not.toContain("DROP TABLE IF EXISTS embedding_cache");
    expect(source).toContain("CREATE TABLE IF NOT EXISTS embedding_cache");
    expect(source).toContain("for (const source of this.sources.listManifests())");
    expect(source).toContain("INSERT INTO provenance_records");
    expect(source).toContain("INSERT OR IGNORE INTO source_blobs");
  });
});
