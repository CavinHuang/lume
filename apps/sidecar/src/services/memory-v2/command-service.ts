import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  MemoryClaim,
  MemoryEvidenceRef,
  MemoryMutationEntrySnapshot,
  MemoryMutationReceipt,
  MemoryMutationResult
} from "@lume/shared";
import { claimFromEntry, claimKey, normalizeMemoryV2Claim } from "./claim";
import { containsSecret } from "./redact";
import { createMemoryV2Store, readActivation, type MemoryV2Store } from "./markdown-store";
import { getMemoryV2ScopePaths } from "./paths";
import { shouldSuppressDurableMemory, smartAddMemoryV2Candidate } from "./smart-add";
import type {
  MemoryV2Candidate,
  MemoryV2Confidence,
  MemoryV2Entry,
  MemoryV2Kind,
  MemoryV2MutationActor,
  MemoryV2MutationReceipt,
  MemoryV2Scope,
  MemoryV2ScopeInput,
  MemoryV2SemanticRole
} from "./types";
import { scheduleDerivedMemoryRebuild } from "./derived-views";

export interface RememberMemoryCommand {
  workspaceSlug: string;
  content: string;
  scope?: MemoryV2ScopeInput;
  legacyKind?: string;
  semanticRole?: MemoryV2SemanticRole;
  facets?: string[];
  confidence?: MemoryV2Confidence;
  claim?: MemoryClaim;
  evidenceRefs?: MemoryEvidenceRef[];
  actor: MemoryV2MutationActor;
  runId?: string;
  threadId?: string;
  explicitCorrection?: boolean;
}

interface MutationJournalRecord {
  receipt: MemoryV2MutationReceipt;
  before: MemoryMutationEntrySnapshot[];
  after: MemoryMutationEntrySnapshot[];
}

type JournalInput = Pick<RememberMemoryCommand, "actor" | "runId" | "threadId"> & { workspaceSlug?: string };

export class MemoryCommandService {
  constructor(private readonly store: MemoryV2Store = createMemoryV2Store()) {}

  async remember(input: RememberMemoryCommand): Promise<MemoryV2MutationReceipt> {
    const content = input.content.trim();
    const scope = inferMemoryScope(input);
    if (!content || shouldSuppressDurableMemory(content) || containsSecret(content)) {
      return this.record(input, scope, "ignored", [], "未保存：内容为空、包含秘密或用户要求不要记住", false);
    }
    const semanticRole = input.semanticRole ?? inferSemanticRole(content, input.legacyKind, input.facets);
    const kind = legacyKindForRole(semanticRole);
    const candidate: MemoryV2Candidate = {
      targetScope: scope,
      kind,
      semanticRole,
      statement: content,
      confidence: input.confidence ?? (input.actor === "background_extract" ? "medium" : "high"),
      tags: input.facets,
      facets: input.facets,
      appliesWhen: scope === "workspace" ? { workspaceSlug: input.workspaceSlug } : {},
      claim: normalizeMemoryV2Claim(input.claim),
      evidence: {
        runId: input.runId,
        recordIds: input.evidenceRefs?.flatMap((ref) => ref.id ? [ref.id] : []),
        sourcePaths: input.evidenceRefs?.flatMap((ref) => ref.path ? [ref.path] : []),
        quote: input.evidenceRefs?.find((ref) => ref.quote)?.quote
      },
      evidenceRefs: input.evidenceRefs
    };

    const conflict = candidate.claim ? this.findClaimConflict(input.workspaceSlug, candidate) : undefined;
    if (conflict && input.explicitCorrection && input.actor !== "background_extract") {
      const entry = this.store.writeEntry(candidate, {
        supersedes: [conflict.frontmatter.id],
        activation: readActivation(conflict.frontmatter),
        evidenceRefs: input.evidenceRefs
      });
      const old = this.store.updateEntryStatus({
        scope: conflict.frontmatter.scope,
        workspaceSlug: input.workspaceSlug,
        id: conflict.frontmatter.id,
        status: "superseded",
        supersededBy: entry.frontmatter.id,
        expectedRevision: conflict.frontmatter.revision
      });
      return this.record(
        input,
        scope,
        "superseded",
        [entry, old],
        "已用明确纠正替换旧记忆",
        true,
        [snapshot(conflict)]
      );
    }

    const result = await smartAddMemoryV2Candidate({
      workspaceSlug: input.workspaceSlug,
      candidate,
      store: this.store
    });
    if (result.entry) {
      return this.record(input, scope, "created", [result.entry], "已记住 1 条信息", true);
    }
    if (result.pending) {
      return this.record(input, scope, "pending", [], "产生 1 条冲突，等待处理", false);
    }
    if (result.action === "duplicate") {
      return this.recordIds(input, scope, "duplicate", result.existingIds ?? [], "这条内容已经记住了", false);
    }
    return this.record(input, scope, "ignored", [], result.reason, false);
  }

  proposePending(input: {
    workspaceSlug: string;
    content: string;
    scope: MemoryV2Scope;
    semanticRole?: MemoryV2SemanticRole;
    confidence?: MemoryV2Confidence;
    facets?: string[];
    claim?: MemoryClaim;
    evidenceRefs?: MemoryEvidenceRef[];
    existingIds?: string[];
    reason: string;
  }): MemoryV2MutationReceipt {
    const candidate: MemoryV2Candidate = {
      targetScope: input.scope,
      semanticRole: input.semanticRole,
      kind: legacyKindForRole(input.semanticRole ?? "fact"),
      statement: input.content.trim(),
      confidence: input.confidence ?? "low",
      facets: input.facets,
      tags: input.facets,
      appliesWhen: input.scope === "workspace" ? { workspaceSlug: input.workspaceSlug } : {},
      claim: normalizeMemoryV2Claim(input.claim),
      evidence: {
        recordIds: input.evidenceRefs?.flatMap((ref) => ref.id ? [ref.id] : []),
        sourcePaths: input.evidenceRefs?.flatMap((ref) => ref.path ? [ref.path] : []),
        quote: input.evidenceRefs?.find((ref) => ref.quote)?.quote
      },
      evidenceRefs: input.evidenceRefs
    };
    this.store.writePending({
      type: input.existingIds?.length ? "conflict" : "low-confidence",
      candidate,
      existingIds: input.existingIds,
      reason: input.reason
    });
    return this.recordIds(
      { actor: "consolidation", workspaceSlug: input.workspaceSlug },
      input.scope,
      "pending",
      [],
      "整理产生 1 条待处理记忆",
      false
    );
  }

  archive(input: {
    workspaceSlug: string;
    id: string;
    scope?: MemoryV2Scope;
    actor: MemoryV2MutationActor;
    runId?: string;
    threadId?: string;
  }): MemoryV2MutationReceipt {
    const entry = this.findEntry(input.workspaceSlug, input.id, input.scope);
    if (!entry) throw new Error(`Memory entry not found: ${input.id}`);
    const archived = this.store.updateEntryStatus({
      scope: entry.frontmatter.scope,
      workspaceSlug: input.workspaceSlug,
      id: entry.frontmatter.id,
      status: "archived",
      expectedRevision: entry.frontmatter.revision
    });
    return this.record(input, entry.frontmatter.scope, "archived", [archived], "已归档 1 条记忆", true, [snapshot(entry)]);
  }

  moveScope(input: {
    workspaceSlug: string;
    id: string;
    scope: MemoryV2Scope;
    targetScope: MemoryV2Scope;
  }): MemoryV2MutationReceipt {
    const entry = this.findEntry(input.workspaceSlug, input.id, input.scope);
    if (!entry) throw new Error(`Memory entry not found: ${input.id}`);
    const moved = this.store.moveEntryScope({
      ...input,
      expectedRevision: entry.frontmatter.revision
    });
    const receipt = this.record(
      { actor: "user", workspaceSlug: input.workspaceSlug },
      input.targetScope,
      "updated",
      [moved],
      `已移动到${input.targetScope === "global" ? "全局" : "工作区"}记忆`,
      false,
      [snapshot(entry)]
    );
    scheduleDerivedMemoryRebuild({
      scope: input.scope,
      ...(input.scope === "workspace" ? { workspaceSlug: input.workspaceSlug } : {})
    });
    return receipt;
  }

  update(input: {
    workspaceSlug: string;
    id: string;
    scope: MemoryV2Scope;
    statement?: string;
    kind?: MemoryV2Kind;
    confidence?: MemoryV2Confidence;
    facets?: string[];
    activation?: ReturnType<typeof readActivation>;
    pinned?: boolean;
    validTo?: string | null;
    evidenceRefs?: MemoryEvidenceRef[];
    expectedRevision?: number;
    actor: MemoryV2MutationActor;
  }): MemoryV2MutationReceipt {
    const entry = this.findEntry(input.workspaceSlug, input.id, input.scope);
    if (!entry) throw new Error(`Memory entry not found: ${input.id}`);
    if (input.expectedRevision !== undefined && entry.frontmatter.revision !== input.expectedRevision) {
      throw new Error("记忆已发生后续修改，请重新整理");
    }
    const updated = this.store.updateEntry({
      scope: input.scope,
      workspaceSlug: input.workspaceSlug,
      id: input.id,
      expectedRevision: entry.frontmatter.revision,
      statement: input.statement,
      kind: input.kind,
      confidence: input.confidence,
      tags: input.facets,
      facets: input.facets,
      activation: input.activation,
      pinned: input.pinned,
      validTo: input.validTo,
      evidenceRefs: input.evidenceRefs
    });
    return this.record(input, input.scope, "updated", [updated], "更新了 1 条记忆", input.actor === "consolidation", [snapshot(entry)]);
  }

  async replaceVersion(input: {
    workspaceSlug: string;
    id: string;
    scope: MemoryV2Scope;
    content: string;
    claim?: MemoryClaim;
    confidence?: MemoryV2Confidence;
    facets?: string[];
    evidenceRefs: MemoryEvidenceRef[];
    explicitCorrection: boolean;
    expectedRevision?: number;
  }): Promise<MemoryV2MutationReceipt> {
    const current = this.findEntry(input.workspaceSlug, input.id, input.scope);
    if (!current) throw new Error(`Memory entry not found: ${input.id}`);
    if (input.expectedRevision !== undefined && current.frontmatter.revision !== input.expectedRevision) {
      throw new Error("记忆已发生后续修改，请重新整理");
    }
    const content = input.content.trim();
    if (!content || shouldSuppressDurableMemory(content) || containsSecret(content)) {
      return this.recordIds({ actor: "consolidation", workspaceSlug: input.workspaceSlug }, input.scope, "ignored", [input.id], "未生成新版本：内容不适合长期记忆", false);
    }
    const existingClaim = claimFromEntry(current);
    const nextClaim = normalizeMemoryV2Claim(input.claim) ?? existingClaim;
    if (
      existingClaim
      && nextClaim
      && claimKey({ scope: input.scope, claim: existingClaim, appliesWhen: current.frontmatter.applies_when })
        === claimKey({ scope: input.scope, claim: nextClaim, appliesWhen: current.frontmatter.applies_when })
      && existingClaim.object.trim().toLowerCase() !== nextClaim.object.trim().toLowerCase()
      && !input.explicitCorrection
    ) {
      return this.remember({
        workspaceSlug: input.workspaceSlug,
        content,
        scope: input.scope,
        semanticRole: current.frontmatter.semantic_role,
        facets: input.facets ?? current.frontmatter.facets,
        confidence: input.confidence ?? current.frontmatter.confidence,
        claim: nextClaim,
        evidenceRefs: input.evidenceRefs,
        actor: "consolidation"
      });
    }
    const candidate: MemoryV2Candidate = {
      targetScope: input.scope,
      kind: current.frontmatter.kind,
      semanticRole: current.frontmatter.semantic_role,
      statement: content,
      confidence: input.confidence ?? current.frontmatter.confidence,
      facets: input.facets ?? current.frontmatter.facets,
      tags: input.facets ?? current.frontmatter.tags,
      entities: current.frontmatter.entities,
      appliesWhen: current.frontmatter.applies_when,
      ...(nextClaim ? { claim: nextClaim } : {})
    };
    const next = this.store.writeEntry(candidate, {
      supersedes: [current.frontmatter.id],
      activation: readActivation(current.frontmatter),
      pinned: current.frontmatter.pinned,
      evidenceRefs: [...current.frontmatter.evidence_refs, ...input.evidenceRefs],
      source: { type: "tool", record_ids: input.evidenceRefs.flatMap((ref) => ref.id ? [ref.id] : []) }
    });
    const previous = this.store.updateEntryStatus({
      scope: input.scope,
      workspaceSlug: input.workspaceSlug,
      id: current.frontmatter.id,
      status: "superseded",
      supersededBy: next.frontmatter.id,
      expectedRevision: current.frontmatter.revision
    });
    return this.record(
      { actor: "consolidation", workspaceSlug: input.workspaceSlug },
      input.scope,
      "superseded",
      [next, previous],
      "整理生成了 1 条新版本记忆",
      true,
      [snapshot(current)]
    );
  }

  markSuspectedStale(input: {
    workspaceSlug: string;
    id: string;
    scope: MemoryV2Scope;
    evidenceRefs?: MemoryEvidenceRef[];
    expectedRevision?: number;
  }): MemoryV2MutationReceipt {
    const entry = this.findEntry(input.workspaceSlug, input.id, input.scope);
    if (!entry) throw new Error(`Memory entry not found: ${input.id}`);
    if (input.expectedRevision !== undefined && entry.frontmatter.revision !== input.expectedRevision) {
      throw new Error("记忆已发生后续修改，请重新整理");
    }
    if (entry.frontmatter.status === "suspected_stale") {
      return this.recordIds({ actor: "consolidation", workspaceSlug: input.workspaceSlug }, input.scope, "duplicate", [input.id], "记忆已标记为可能过期", false);
    }
    const updated = this.store.updateEntryStatus({
      scope: input.scope,
      workspaceSlug: input.workspaceSlug,
      id: input.id,
      status: "suspected_stale",
      evidenceRefs: input.evidenceRefs,
      expectedRevision: entry.frontmatter.revision
    });
    return this.record({ actor: "consolidation", workspaceSlug: input.workspaceSlug }, input.scope, "updated", [updated], "已标记 1 条可能过期记忆", true, [snapshot(entry)]);
  }

  mergeDuplicate(input: {
    workspaceSlug: string;
    duplicateId: string;
    keptId: string;
    scope: MemoryV2Scope;
    expectedKeptRevision?: number;
    expectedDuplicateRevision?: number;
  }): MemoryV2MutationReceipt {
    const kept = this.findEntry(input.workspaceSlug, input.keptId, input.scope);
    const duplicate = this.findEntry(input.workspaceSlug, input.duplicateId, input.scope);
    if (!kept) throw new Error(`Memory entry not found: ${input.keptId}`);
    if (!duplicate) throw new Error(`Memory entry not found: ${input.duplicateId}`);
    if (input.expectedKeptRevision !== undefined && kept.frontmatter.revision !== input.expectedKeptRevision) {
      throw new Error("保留记忆已发生后续修改，请重新整理");
    }
    if (input.expectedDuplicateRevision !== undefined && duplicate.frontmatter.revision !== input.expectedDuplicateRevision) {
      throw new Error("重复记忆已发生后续修改，请重新整理");
    }
    const activation = readActivation(kept.frontmatter);
    const duplicateActivation = readActivation(duplicate.frontmatter);
    const updatedKept = this.store.updateEntry({
      scope: input.scope,
      workspaceSlug: input.workspaceSlug,
      id: input.keptId,
      expectedRevision: kept.frontmatter.revision,
      confidence: strongerConfidence(kept.frontmatter.confidence, duplicate.frontmatter.confidence),
      facets: [...kept.frontmatter.facets, ...duplicate.frontmatter.facets],
      tags: [...kept.frontmatter.tags, ...duplicate.frontmatter.tags],
      pinned: kept.frontmatter.pinned || duplicate.frontmatter.pinned,
      activation: {
        recall: activation.recall || duplicateActivation.recall,
        persona: activation.persona || duplicateActivation.persona,
        suggestion: activation.suggestion || duplicateActivation.suggestion,
        analyst: activation.analyst || duplicateActivation.analyst
      },
      evidenceRefs: [...kept.frontmatter.evidence_refs, ...duplicate.frontmatter.evidence_refs]
    });
    const updatedDuplicate = this.store.updateEntryStatus({
      scope: input.scope,
      workspaceSlug: input.workspaceSlug,
      id: input.duplicateId,
      status: "superseded",
      supersededBy: input.keptId,
      expectedRevision: duplicate.frontmatter.revision
    });
    return this.record(
      { actor: "consolidation", workspaceSlug: input.workspaceSlug },
      input.scope,
      "merged",
      [updatedKept, updatedDuplicate],
      "合并了 1 条重复记忆",
      true,
      [snapshot(kept), snapshot(duplicate)]
    );
  }

  resolvePending(input: {
    workspaceSlug: string;
    path: string;
    action: "accept" | "reject" | "resolve";
    candidateOverride?: {
      statement?: string;
      kind?: MemoryV2Kind;
      confidence?: MemoryV2Confidence;
      tags?: string[];
    };
  }): { result: MemoryMutationResult; receipt: MemoryV2MutationReceipt } {
    const pending = this.store.listPending({ workspaceSlug: input.workspaceSlug })
      .find((item) => item.path === input.path);
    if (!pending) throw new Error("Memory pending item not found");
    const result = this.store.resolvePending(input);
    const ids = result.entryId ? [result.entryId] : [];
    const action = input.action === "accept" ? "created" : "archived";
    const acceptedEntry = result.entryId
      ? this.findEntry(input.workspaceSlug, result.entryId, pending.frontmatter.candidate.targetScope)
      : undefined;
    return {
      result,
      receipt: acceptedEntry
        ? this.record(
          { actor: "user", workspaceSlug: input.workspaceSlug },
          pending.frontmatter.candidate.targetScope,
          action,
          [acceptedEntry],
          "已接受 1 条待处理记忆",
          true
        )
        : this.recordIds(
          { actor: "user", workspaceSlug: input.workspaceSlug },
          pending.frontmatter.candidate.targetScope,
          action,
          ids,
          input.action === "accept" ? "已接受 1 条待处理记忆" : "已处理 1 条待处理记忆",
          input.action === "accept"
        )
    };
  }

  undo(input: { workspaceSlug: string; mutationId: string }): MemoryV2MutationReceipt {
    const record = this.findJournalRecord(input.workspaceSlug, input.mutationId);
    if (!record || !record.receipt.undoable) throw new Error("该记忆变更不可撤销");
    const beforeUndo: MemoryMutationEntrySnapshot[] = [];
    for (const expected of record.after) {
      const current = this.findEntry(input.workspaceSlug, expected.id, expected.scope);
      if (!current || current.frontmatter.revision !== expected.revision) {
        throw new Error("记忆已发生后续修改，请手动修正");
      }
      beforeUndo.push(snapshot(current));
    }
    const restored: MemoryV2Entry[] = [];
    for (const before of record.before) {
      const current = this.findEntry(input.workspaceSlug, before.id, before.scope);
      if (!current) throw new Error("无法恢复已物理删除的记忆");
      restored.push(this.store.updateEntryStatus({
        scope: before.scope,
        workspaceSlug: input.workspaceSlug,
        id: before.id,
        status: "active",
        supersededBy: null,
        expectedRevision: current.frontmatter.revision
      }));
    }
    for (const created of record.after.filter((item) => !record.before.some((before) => before.id === item.id))) {
      const current = this.findEntry(input.workspaceSlug, created.id, created.scope);
      if (current) restored.push(this.store.updateEntryStatus({
        scope: created.scope,
        workspaceSlug: input.workspaceSlug,
        id: created.id,
        status: "archived",
        expectedRevision: current.frontmatter.revision
      }));
    }
    return this.record(
      { actor: "user", workspaceSlug: input.workspaceSlug },
      record.receipt.scope,
      "updated",
      restored,
      "已撤销记忆变更",
      false,
      beforeUndo
    );
  }

  private findClaimConflict(workspaceSlug: string, candidate: MemoryV2Candidate): MemoryV2Entry | undefined {
    if (!candidate.claim) return undefined;
    const candidateKey = claimKey({ scope: candidate.targetScope, claim: candidate.claim, appliesWhen: candidate.appliesWhen });
    return this.store.listEntries({ workspaceSlug, scopes: [candidate.targetScope], includeStatuses: ["active", "suspected_stale"] })
      .find((entry) => {
        const claim = claimFromEntry(entry);
        return claim && claimKey({ scope: entry.frontmatter.scope, claim, appliesWhen: entry.frontmatter.applies_when }) === candidateKey
          && claim.object.trim().toLowerCase() !== candidate.claim!.object.trim().toLowerCase();
      });
  }

  private findEntry(workspaceSlug: string, id: string, scope?: MemoryV2Scope): MemoryV2Entry | undefined {
    return this.store.listEntries({
      workspaceSlug,
      scopes: scope ? [scope] : ["global", "workspace"],
      includeStatuses: ["active", "suspected_stale", "archived", "superseded"]
    }).find((entry) => entry.frontmatter.id === id);
  }

  private record(
    input: JournalInput,
    scope: MemoryV2Scope,
    action: MemoryV2MutationReceipt["action"],
    entries: MemoryV2Entry[],
    summary: string,
    undoable: boolean,
    before: MemoryMutationEntrySnapshot[] = []
  ): MemoryV2MutationReceipt {
    return this.recordIds(input, scope, action, entries.map((entry) => entry.frontmatter.id), summary, undoable, before, entries.map(snapshot));
  }

  private recordIds(
    input: JournalInput,
    scope: MemoryV2Scope,
    action: MemoryV2MutationReceipt["action"],
    ids: string[],
    summary: string,
    undoable: boolean,
    before: MemoryMutationEntrySnapshot[] = [],
    after: MemoryMutationEntrySnapshot[] = []
  ): MemoryV2MutationReceipt {
    const receipt: MemoryV2MutationReceipt = {
      mutationId: randomUUID(),
      actor: input.actor,
      action,
      memoryIds: ids,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      scope,
      ...(after[0] ? { revision: after[0].revision } : {}),
      summary,
      undoable,
      createdAt: new Date().toISOString()
    };
    const paths = getMemoryV2ScopePaths({ scope, workspaceSlug: scope === "workspace" ? input.workspaceSlug : undefined });
    const journalPath = join(paths.journalDir, `${receipt.createdAt.slice(0, 10)}.jsonl`);
    writeFileSync(journalPath, `${JSON.stringify({ receipt, before, after } satisfies MutationJournalRecord)}\n`, { flag: "a", encoding: "utf-8" });
    if (["created", "updated", "superseded", "merged", "archived"].includes(action)) {
      scheduleDerivedMemoryRebuild({ scope, workspaceSlug: scope === "workspace" ? input.workspaceSlug : undefined });
    }
    return receipt;
  }

  private findJournalRecord(workspaceSlug: string, mutationId: string): MutationJournalRecord | undefined {
    for (const scope of ["global", "workspace"] as const) {
      const paths = getMemoryV2ScopePaths({ scope, workspaceSlug: scope === "workspace" ? workspaceSlug : undefined });
      if (!existsSync(paths.journalDir)) continue;
      for (const name of readdirSync(paths.journalDir)) {
        const path = join(paths.journalDir, name);
        const records = readFileSync(path, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as MutationJournalRecord);
        const match = records.find((item) => item.receipt.mutationId === mutationId);
        if (match) return match;
      }
    }
    return undefined;
  }
}

function inferMemoryScope(input: RememberMemoryCommand): MemoryV2Scope {
  if (input.scope === "global" || input.scope === "workspace") return input.scope;
  const text = input.content.toLowerCase();
  if (input.semanticRole === "identity" || /我的名字|叫我|称呼我|i am |my name|跨项目|所有项目|always respond|默认用.*回答/.test(text)) return "global";
  if (input.semanticRole === "preference" && !/这个项目|当前项目|workspace|repository|repo|代码库/.test(text)) return "global";
  return "workspace";
}

function inferSemanticRole(content: string, legacyKind?: string, facets?: string[]): MemoryV2SemanticRole {
  if ((facets ?? []).some((facet) => ["identity", "preferred-name"].includes(facet))) return "identity";
  if (/我的名字|叫我|称呼我|my name|call me/i.test(content)) return "identity";
  if (/必须|禁止|不能|must|never|required/i.test(content)) return "constraint";
  if (legacyKind === "preference" || /喜欢|偏好|默认|prefer/i.test(content)) return "preference";
  if (legacyKind === "decision" || /决定|选用|decision/i.test(content)) return "decision";
  if (legacyKind === "lesson" || /经验|教训|lesson/i.test(content)) return "lesson";
  if (["summary", "episode", "milestone"].includes(legacyKind ?? "")) return "state";
  return "fact";
}

function legacyKindForRole(role: MemoryV2SemanticRole): MemoryV2Kind {
  if (role === "preference" || role === "decision" || role === "lesson" || role === "state") return role;
  return "fact";
}

function strongerConfidence(left: MemoryV2Confidence, right: MemoryV2Confidence): MemoryV2Confidence {
  const rank: Record<MemoryV2Confidence, number> = { low: 0, medium: 1, high: 2 };
  return rank[left] >= rank[right] ? left : right;
}

function snapshot(entry: MemoryV2Entry): MemoryMutationEntrySnapshot {
  return {
    id: entry.frontmatter.id,
    scope: entry.frontmatter.scope,
    revision: entry.frontmatter.revision,
    statement: entry.statement,
    status: entry.frontmatter.status,
    semanticRole: entry.frontmatter.semantic_role,
    confidence: entry.frontmatter.confidence,
    facets: entry.frontmatter.facets,
    pinned: entry.frontmatter.pinned,
    activation: readActivation(entry.frontmatter),
    ...(entry.frontmatter.valid_from ? { validFrom: entry.frontmatter.valid_from } : {}),
    ...(entry.frontmatter.valid_to ? { validTo: entry.frontmatter.valid_to } : {}),
    supersedes: entry.frontmatter.supersedes,
    ...(entry.frontmatter.superseded_by ? { supersededBy: entry.frontmatter.superseded_by } : {})
  };
}

export function toSharedMemoryReceipt(receipt: MemoryV2MutationReceipt): MemoryMutationReceipt {
  return receipt;
}

export function hasMemoryMutationForRun(input: {
  workspaceSlug: string;
  runId: string;
  actor?: MemoryV2MutationActor;
}): boolean {
  for (const scope of ["global", "workspace"] as const) {
    const paths = getMemoryV2ScopePaths({ scope, workspaceSlug: scope === "workspace" ? input.workspaceSlug : undefined });
    for (const name of readdirSync(paths.journalDir)) {
      if (!name.endsWith(".jsonl")) continue;
      const records = readFileSync(join(paths.journalDir, name), "utf-8").split("\n").filter(Boolean);
      for (const line of records) {
        try {
          const record = JSON.parse(line) as MutationJournalRecord;
          if (record.receipt.runId === input.runId && (!input.actor || record.receipt.actor === input.actor)) return true;
        } catch {
          continue;
        }
      }
    }
  }
  return false;
}
