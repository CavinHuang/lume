import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryClaim, MemoryEvidenceRef, MemoryMutationReceipt } from "@lume/shared";
import { claimFromEntry, claimKey, normalizeMemoryV2Claim } from "./claim";
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

interface MutationSnapshot {
  id: string;
  scope: MemoryV2Scope;
  revision: number;
}

interface MutationJournalRecord {
  receipt: MemoryV2MutationReceipt;
  before: MutationSnapshot[];
  after: MutationSnapshot[];
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
      }
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
      return this.record(input, scope, "pending", [], "产生 1 条待处理记忆", false);
    }
    if (result.action === "duplicate") {
      return this.recordIds(input, scope, "duplicate", result.existingIds ?? [], "这条内容已经记住了", false);
    }
    return this.record(input, scope, "ignored", [], result.reason, false);
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

  markSuspectedStale(input: {
    workspaceSlug: string;
    id: string;
    scope: MemoryV2Scope;
  }): MemoryV2MutationReceipt {
    const entry = this.findEntry(input.workspaceSlug, input.id, input.scope);
    if (!entry) throw new Error(`Memory entry not found: ${input.id}`);
    if (entry.frontmatter.status === "suspected_stale") {
      return this.recordIds({ actor: "consolidation", workspaceSlug: input.workspaceSlug }, input.scope, "duplicate", [input.id], "记忆已标记为可能过期", false);
    }
    const updated = this.store.updateEntryStatus({
      scope: input.scope,
      workspaceSlug: input.workspaceSlug,
      id: input.id,
      status: "suspected_stale",
      expectedRevision: entry.frontmatter.revision
    });
    return this.record({ actor: "consolidation", workspaceSlug: input.workspaceSlug }, input.scope, "updated", [updated], "已标记 1 条可能过期记忆", true, [snapshot(entry)]);
  }

  undo(input: { workspaceSlug: string; mutationId: string }): MemoryV2MutationReceipt {
    const record = this.findJournalRecord(input.workspaceSlug, input.mutationId);
    if (!record || !record.receipt.undoable) throw new Error("该记忆变更不可撤销");
    for (const expected of record.after) {
      const current = this.findEntry(input.workspaceSlug, expected.id, expected.scope);
      if (!current || current.frontmatter.revision !== expected.revision) {
        throw new Error("记忆已发生后续修改，请手动修正");
      }
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
    return this.recordIds({ actor: "user", workspaceSlug: input.workspaceSlug }, record.receipt.scope, "updated", restored.map((item) => item.frontmatter.id), "已撤销记忆变更", false);
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
    before: MutationSnapshot[] = []
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
    before: MutationSnapshot[] = [],
    after: MutationSnapshot[] = []
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

function containsSecret(content: string): boolean {
  return /(?:api[_-]?key|token|password|密码|验证码|secret)\s*[:=]\s*\S+|\bsk-[A-Za-z0-9_-]{16,}\b/i.test(content);
}

function snapshot(entry: MemoryV2Entry): MutationSnapshot {
  return { id: entry.frontmatter.id, scope: entry.frontmatter.scope, revision: entry.frontmatter.revision };
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
