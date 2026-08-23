import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MemoryCommandService } from "./command-service";
import { createMemoryV2Store, readActivation } from "./markdown-store";
import { getMemoryV2ScopePaths } from "./paths";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-memory-command-"));
  process.env.LUME_CONFIG_DIR = root;
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("MemoryCommandService", () => {
  test("infers global identity scope and writes a journal receipt", async () => {
    const receipt = await new MemoryCommandService().remember({
      workspaceSlug: "demo",
      content: "我的名字是 Cavin",
      scope: "auto",
      actor: "main_agent"
    });
    expect(receipt.action).toBe("created");
    expect(receipt.scope).toBe("global");
    expect(receipt.undoable).toBe(true);
    const entry = createMemoryV2Store().listEntries({ workspaceSlug: "demo", scopes: ["global"] })[0]!;
    expect(entry.frontmatter.semantic_role).toBe("identity");
    expect(entry.frontmatter.revision).toBe(1);
    expect(entry.frontmatter.evidence_refs[0]?.type).toBe("manual");
  });

  test("filters secrets before durable write", async () => {
    const receipt = await new MemoryCommandService().remember({
      workspaceSlug: "demo",
      content: "API token = sk-abcdefghijklmnopqrstuvwxyz",
      actor: "main_agent"
    });
    expect(receipt.action).toBe("ignored");
    expect(createMemoryV2Store().listEntries({ workspaceSlug: "demo" })).toHaveLength(0);
  });

  test("redacts secret-bearing evidence quotes in persisted frontmatter (#449)", async () => {
    const service = new MemoryCommandService();
    const secretQuote = "用户粘贴了 api_key=sk-secretvalue123456 并让我保存";
    const receipt = await service.remember({
      workspaceSlug: "demo",
      content: "用户偏好用环境变量管理密钥",
      evidenceRefs: [{ type: "user_message", id: "msg-1", runId: "run-1", threadId: "t1", quote: secretQuote }],
      actor: "main_agent",
      runId: "run-1"
    });
    expect(receipt.action).toBe("created");
    const entriesDir = getMemoryV2ScopePaths({ scope: "workspace", workspaceSlug: "demo" }).entriesDir;
    const raw = readdirSync(entriesDir).map((name) => readFileSync(join(entriesDir, name), "utf-8")).join("\n");
    expect(raw).not.toContain(secretQuote);
    expect(raw).not.toContain("sk-secretvalue123456");
    expect(raw).toContain("[证据原文含疑似密钥，已省略]");

    // pending 路径同样落盘 evidence_refs.quote
    service.proposePending({
      workspaceSlug: "demo",
      content: "另一条待确认记忆",
      scope: "workspace",
      reason: "低置信度",
      evidenceRefs: [{ type: "user_message", id: "msg-2", quote: "token: ghp_abcdefghijklmnopqrstuvwxyz123456" }]
    });
    const pendingRaw = getMemoryV2ScopePaths({ scope: "workspace", workspaceSlug: "demo" }).pendingLowConfidenceDir;
    const pendingFiles = readdirSync(pendingRaw).map((name) => readFileSync(join(pendingRaw, name), "utf-8")).join("\n");
    expect(pendingFiles).toContain("[证据原文含疑似密钥，已省略]");
    expect(pendingFiles).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
  });

  test("explicit correction supersedes while background conflict stays pending", async () => {
    const service = new MemoryCommandService();
    await service.remember({
      workspaceSlug: "demo",
      content: "默认回答语言是英文",
      scope: "global",
      semanticRole: "preference",
      claim: { subject: "user", predicate: "response_language", object: "English" },
      actor: "user"
    });
    const pending = await service.remember({
      workspaceSlug: "demo",
      content: "默认回答语言是中文",
      scope: "global",
      semanticRole: "preference",
      claim: { subject: "user", predicate: "response_language", object: "Chinese" },
      actor: "background_extract"
    });
    expect(pending.action).toBe("pending");

    const corrected = await service.remember({
      workspaceSlug: "demo",
      content: "纠正：默认回答语言是中文",
      scope: "global",
      semanticRole: "preference",
      claim: { subject: "user", predicate: "response_language", object: "Chinese" },
      actor: "user",
      explicitCorrection: true
    });
    expect(corrected.action).toBe("superseded");
    const entries = createMemoryV2Store().listEntries({
      workspaceSlug: "demo",
      scopes: ["global"],
      includeStatuses: ["active", "superseded"]
    });
    expect(entries.filter((entry) => entry.frontmatter.status === "active")).toHaveLength(1);
    expect(entries.filter((entry) => entry.frontmatter.status === "superseded")).toHaveLength(1);
  });

  test("updates pin and validity and moves an entry across scopes", async () => {
    const service = new MemoryCommandService();
    const created = await service.remember({
      workspaceSlug: "demo",
      content: "项目默认使用 Bun",
      scope: "workspace",
      actor: "user"
    });
    const id = created.memoryIds[0]!;
    const validTo = "2027-01-01T23:59:59.999Z";
    service.update({
      workspaceSlug: "demo",
      id,
      scope: "workspace",
      pinned: true,
      validTo,
      actor: "user"
    });
    service.moveScope({
      workspaceSlug: "demo",
      id,
      scope: "workspace",
      targetScope: "global"
    });
    const moved = createMemoryV2Store().listEntries({ scopes: ["global"] })
      .find((entry) => entry.frontmatter.id === id);
    expect(moved?.frontmatter.pinned).toBe(true);
    expect(moved?.frontmatter.valid_to).toBe(validTo);
    expect(createMemoryV2Store().listEntries({ workspaceSlug: "demo", scopes: ["workspace"] }))
      .toHaveLength(0);
  });

  test("records displayable before and after snapshots for updates and archives", async () => {
    const service = new MemoryCommandService();
    const created = await service.remember({
      workspaceSlug: "demo",
      content: "项目默认使用 Bun",
      scope: "workspace",
      actor: "user"
    });
    const id = created.memoryIds[0]!;

    const updated = service.update({
      workspaceSlug: "demo",
      id,
      scope: "workspace",
      statement: "项目默认使用 Bun 和 TypeScript",
      actor: "user"
    });
    expect(updated.action).toBe("updated");

    service.archive({ workspaceSlug: "demo", id, scope: "workspace", actor: "user" });
    const journalDir = getMemoryV2ScopePaths({ scope: "workspace", workspaceSlug: "demo" }).journalDir;
    const journal = readdirSync(journalDir).find((name) => name.endsWith(".jsonl"))!;
    const records = readFileSync(join(journalDir, journal), "utf-8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { receipt: { mutationId: string }; before: Array<{ statement?: string; status?: string }>; after: Array<{ statement?: string; status?: string }> });
    const updatedRecord = records.find((record) => record.receipt.mutationId === updated.mutationId)!;
    const archivedRecord = records.at(-1)!;

    expect(updatedRecord.before[0]?.statement).toBe("项目默认使用 Bun");
    expect(updatedRecord.after[0]?.statement).toBe("项目默认使用 Bun 和 TypeScript");
    expect(archivedRecord.before[0]?.statement).toBe("项目默认使用 Bun 和 TypeScript");
    expect(archivedRecord.after[0]?.status).toBe("archived");
  });

  test("records the restored state created by an undo mutation", async () => {
    const service = new MemoryCommandService();
    const created = await service.remember({ workspaceSlug: "demo", content: "使用中文", scope: "global", actor: "user" });
    const id = created.memoryIds[0]!;

    const undone = service.undo({ workspaceSlug: "demo", mutationId: created.mutationId });
    expect(undone.summary).toBe("已撤销记忆变更");

    const entry = createMemoryV2Store().listEntries({ scopes: ["global"], includeStatuses: ["archived"] })
      .find((item) => item.frontmatter.id === id)!;
    expect(entry.frontmatter.status).toBe("archived");
    const journalDir = getMemoryV2ScopePaths({ scope: "global" }).journalDir;
    const journal = readdirSync(journalDir).find((name) => name.endsWith(".jsonl"))!;
    const records = readFileSync(join(journalDir, journal), "utf-8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { receipt: { summary: string }; before: Array<{ status?: string }>; after: Array<{ status?: string }> });
    const undoRecord = records.find((record) => record.receipt.summary === "已撤销记忆变更")!;
    expect(undoRecord.before[0]?.status).toBe("active");
    expect(undoRecord.after[0]?.status).toBe("archived");
  });

  test("Dream replacement preserves activation, pin and the evidence chain", async () => {
    const service = new MemoryCommandService();
    const created = await service.remember({
      workspaceSlug: "demo",
      content: "默认回答语言是英文",
      scope: "global",
      semanticRole: "preference",
      claim: { subject: "user", predicate: "response_language", object: "English" },
      evidenceRefs: [{ type: "user_message", id: "old-message" }],
      actor: "user"
    });
    const id = created.memoryIds[0]!;
    service.update({
      workspaceSlug: "demo",
      id,
      scope: "global",
      pinned: true,
      activation: { recall: true, persona: true, suggestion: false, analyst: false },
      actor: "user"
    });
    const current = createMemoryV2Store().listEntries({ scopes: ["global"] })[0]!;

    const replaced = await service.replaceVersion({
      workspaceSlug: "demo",
      id,
      scope: "global",
      content: "默认回答语言是中文",
      claim: { subject: "user", predicate: "response_language", object: "Chinese" },
      evidenceRefs: [{ type: "user_message", id: "correction-message" }],
      explicitCorrection: true,
      expectedRevision: current.frontmatter.revision
    });

    expect(replaced.action).toBe("superseded");
    const active = createMemoryV2Store().listEntries({ scopes: ["global"] })
      .find((entry) => entry.frontmatter.id === replaced.memoryIds[0])!;
    expect(active.frontmatter.pinned).toBe(true);
    expect(readActivation(active.frontmatter).persona).toBe(true);
    expect(active.frontmatter.evidence_refs.map((ref) => ref.id)).toEqual(["old-message", "correction-message"]);
    expect(active.frontmatter.supersedes).toEqual([id]);
  });

  test("Dream duplicate merge combines metadata and revision-checks both entries", () => {
    const store = createMemoryV2Store();
    const service = new MemoryCommandService(store);
    const kept = store.writeEntry({
      targetScope: "workspace",
      kind: "preference",
      semanticRole: "preference",
      statement: "默认使用中文回答",
      confidence: "medium",
      facets: ["language"],
      appliesWhen: { workspaceSlug: "demo" }
    }, { evidenceRefs: [{ type: "user_message", id: "first" }] });
    const duplicate = store.writeEntry({
      targetScope: "workspace",
      kind: "preference",
      semanticRole: "preference",
      statement: "回答时默认使用中文",
      confidence: "high",
      facets: ["response"],
      appliesWhen: { workspaceSlug: "demo" }
    }, {
      pinned: true,
      activation: { recall: true, persona: false, suggestion: true, analyst: false },
      evidenceRefs: [{ type: "user_message", id: "second" }]
    });

    const receipt = service.mergeDuplicate({
      workspaceSlug: "demo",
      keptId: kept.frontmatter.id,
      duplicateId: duplicate.frontmatter.id,
      scope: "workspace",
      expectedKeptRevision: kept.frontmatter.revision,
      expectedDuplicateRevision: duplicate.frontmatter.revision
    });

    expect(receipt.action).toBe("merged");
    const entries = store.listEntries({ workspaceSlug: "demo", includeStatuses: ["active", "superseded"] });
    const merged = entries.find((entry) => entry.frontmatter.id === kept.frontmatter.id)!;
    const superseded = entries.find((entry) => entry.frontmatter.id === duplicate.frontmatter.id)!;
    expect(merged.frontmatter.confidence).toBe("high");
    expect(merged.frontmatter.facets).toEqual(["language", "response"]);
    expect(merged.frontmatter.pinned).toBe(true);
    expect(readActivation(merged.frontmatter).suggestion).toBe(true);
    expect(merged.frontmatter.evidence_refs.map((ref) => ref.id)).toEqual(["first", "second"]);
    expect(superseded.frontmatter.superseded_by).toBe(kept.frontmatter.id);
  });

  test("Dream pending candidates preserve semantic metadata and exact evidence when accepted", () => {
    const store = createMemoryV2Store();
    const service = new MemoryCommandService(store);
    const receipt = service.proposePending({
      workspaceSlug: "demo",
      content: "用户倾向在这个工作区使用中文",
      scope: "workspace",
      semanticRole: "preference",
      facets: ["language"],
      evidenceRefs: [{ type: "user_message", id: "message-1", runId: "run-1", quote: "默认中文" }],
      reason: "证据不足"
    });
    expect(receipt.action).toBe("pending");
    const pending = store.listPending({ workspaceSlug: "demo" })[0]!;
    expect(pending.frontmatter.candidate.semantic_role).toBe("preference");
    expect(pending.frontmatter.candidate.facets).toEqual(["language"]);
    expect(pending.frontmatter.evidence_refs?.[0]).toMatchObject({ type: "user_message", id: "message-1", runId: "run-1" });

    const accepted = service.resolvePending({ workspaceSlug: "demo", path: pending.path, action: "accept" });
    const entry = store.listEntries({ workspaceSlug: "demo" })
      .find((item) => item.frontmatter.id === accepted.result.entryId)!;
    expect(entry.frontmatter.semantic_role).toBe("preference");
    expect(entry.frontmatter.facets).toEqual(["language"]);
    expect(entry.frontmatter.evidence_refs[0]).toMatchObject({ type: "user_message", id: "message-1", runId: "run-1" });
  });
});
