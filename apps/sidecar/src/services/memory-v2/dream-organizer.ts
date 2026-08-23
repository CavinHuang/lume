import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import type { SDKMessage } from "@lume/agent-sdk";
import type {
  AgentAskUserQuestionRequest,
  AgentToolPermissionRequest,
  MemoryDreamAction,
  MemoryDreamResult,
  MemoryDreamResultItem,
  MemoryEvidenceRef,
  MemoryMutationEntrySnapshot,
  MemoryOrganizeProgress
} from "@lume/shared";
import { resolveChannelModelBinding } from "../channel/channel-manager";
import { createAgentThreadWithModelRef, getAgentThreadSDKMessages } from "../agent/agent-thread-manager";
import { getAgentWorkspaceBySlug } from "../agent/agent-workspace-manager";
import { sendAgentMessage } from "../agent/agent-service";
import { getSubagentCoordinator } from "../agent-runtime/subagents/subagent-coordinator";
import { claimFromEntry, claimKey, normalizeMemoryV2Claim } from "./claim";
import { MemoryCommandService } from "./command-service";
import { areMemoryStatementsSimilar } from "./dedupe";
import { loadDreamEvidenceForJob, type DreamEvidenceItem, type DreamEvidenceWindow } from "./dream-evidence";
import { createMemoryV2Store, readActivation } from "./markdown-store";
import { getMemoryRuntimeConfig } from "./policy";
import { resolveMemoryRerankModelRef } from "./rerank";
import type { MemoryV2Claim, MemoryV2Confidence, MemoryV2Entry, MemoryV2Scope, MemoryV2SemanticRole } from "./types";

const MAX_DREAM_AGENT_ROUNDS = 20;
const MAX_ENTRY_MANIFEST_ITEMS = 200;

type DreamProposalOperation = "create" | "replace_version" | "merge" | "update_metadata" | "mark_stale";

interface MemoryDreamProposal {
  operation: DreamProposalOperation;
  reason: string;
  scope?: MemoryV2Scope;
  targetId?: string;
  keepId?: string;
  duplicateIds?: string[];
  content?: string;
  semanticRole?: MemoryV2SemanticRole;
  confidence?: MemoryV2Confidence;
  facets?: string[];
  validTo?: string | null;
  claim?: MemoryV2Claim;
  evidenceIds: string[];
  explicitUserStatement?: boolean;
  explicitCorrection?: boolean;
  workspaceEvidence?: Array<{ path: string; quote?: string }>;
}

export interface RunDreamOrganizerInput {
  workspaceSlug: string;
  jobId: string;
  evidenceWindow: DreamEvidenceWindow;
  modelRef?: string;
  agentContext?: { threadId: string; runId: string };
  signal?: AbortSignal;
  onProgress?: (progress: MemoryOrganizeProgress) => void;
}

export async function runDreamOrganizer(input: RunDreamOrganizerInput): Promise<MemoryDreamResult> {
  input.signal?.throwIfAborted();
  const store = createMemoryV2Store();
  const commands = new MemoryCommandService(store);
  const entries = store.listEntries({
    workspaceSlug: input.workspaceSlug,
    scopes: ["global", "workspace"],
    includeStatuses: ["active", "suspected_stale"]
  });
  const evidence = loadDreamEvidenceForJob(input.workspaceSlug, input.jobId);
  input.onProgress?.({
    label: "读取记忆与近期证据",
    scannedItems: entries.length,
    processedItems: 0,
    reviewedSessions: input.evidenceWindow.threadIds.length,
    reviewedEvidence: evidence.length
  });
  const proposals = [
    ...await runDreamAgent(input, entries, evidence),
    ...expiredEntryProposals(entries)
  ];
  input.signal?.throwIfAborted();
  input.onProgress?.({
    label: "验证整理方案",
    scannedItems: entries.length,
    processedItems: 0,
    reviewedSessions: input.evidenceWindow.threadIds.length,
    reviewedEvidence: evidence.length,
    proposedActions: proposals.length
  });
  const items: MemoryDreamResultItem[] = [];
  const warnings: string[] = [];
  for (const proposal of proposals) {
    input.signal?.throwIfAborted();
    try {
      items.push(...await applyProposal({ input, proposal, evidence, entries, commands, store }));
    } catch (error) {
      warnings.push(`${proposal.operation}: ${error instanceof Error ? error.message : String(error)}`);
      items.push({
        action: "ignored",
        memoryIds: proposal.targetId ? [proposal.targetId] : [],
        reason: `${proposal.reason}；提交失败：${error instanceof Error ? error.message : String(error)}`,
        evidenceRefs: [],
        undoable: false
      });
    }
    input.onProgress?.({
      label: "提交记忆变更",
      scannedItems: entries.length,
      processedItems: items.length,
      reviewedSessions: input.evidenceWindow.threadIds.length,
      reviewedEvidence: evidence.length,
      proposedActions: proposals.length,
      changedItems: items.filter((item) => item.action !== "ignored").length
    });
  }
  return {
    sessionsReviewed: input.evidenceWindow.threadIds.length,
    evidenceItemsReviewed: evidence.length,
    scannedEntries: entries.length,
    actions: countActions(items),
    items,
    rebuilt: [],
    warnings
  };
}

async function runDreamAgent(
  input: RunDreamOrganizerInput,
  entries: MemoryV2Entry[],
  evidence: DreamEvidenceItem[]
): Promise<MemoryDreamProposal[]> {
  const runtimeConfig = getMemoryRuntimeConfig();
  const resolved = resolveMemoryRerankModelRef({
    workspaceSlug: input.workspaceSlug,
    explicitModelRef: input.modelRef ?? runtimeConfig.retrieval.rerankModelRef
  });
  if (!resolved.modelRef) throw new Error("记忆整理没有可用模型");
  const binding = resolveChannelModelBinding(resolved.modelRef, "chat");
  const workspace = getAgentWorkspaceBySlug(input.workspaceSlug);
  if (!binding || !workspace) throw new Error("记忆整理无法解析工作区模型");
  const prompt = buildDreamPrompt(input, entries, evidence);
  const coordinator = getSubagentCoordinator();
  let plan: MemoryDreamProposal[] = [];
  const parentThreadId = input.agentContext?.threadId ?? `memory-dream:${input.jobId}`;
  const parentRunId = input.agentContext?.runId ?? input.jobId;
  const result = await coordinator.runAgentTask({
    parentThreadId,
    parentRunId,
    parentToolUseId: `memory-dream:${input.jobId}`,
    prompt,
    description: "Private evidence-driven memory Dream",
    subagentType: "memory-organizer",
    acceptanceCriteria: [
      "Every proposal cites evidence from this Dream job.",
      "Assistant text is never the sole evidence for a durable memory.",
      "No project or memory files are modified by the child agent."
    ],
    createSession: ({ title }) => {
      const child = createAgentThreadWithModelRef(
        title,
        resolved.modelRef,
        binding.channel.id,
        workspace.id,
        input.agentContext?.threadId,
        binding.modelId,
        { fileContextMode: "newRoot", memoryProfile: { kind: "dream", jobId: input.jobId } }
      );
      return { threadId: child.id, modelRef: resolved.modelRef! };
    },
    execute: async ({ session, run, signal }) => {
      const abortSignal = input.signal ? AbortSignal.any([signal, input.signal]) : signal;
      await sendAgentMessage({
        threadId: session.threadId,
        userMessage: prompt,
        modelRef: resolved.modelRef!,
        channelId: binding.channel.id,
        modelId: binding.modelId,
        workspaceId: workspace.id,
        threadType: "subagent",
        messageMetadata: {
          hiddenFromChat: true,
          memoryBackground: true,
          memoryBackgroundKind: "dream",
          maxTurns: MAX_DREAM_AGENT_ROUNDS,
          toolPolicy: {
            allow: ["memory.search", "memory.read", "memory.evidence.search", "memory.evidence.read", "Read", "Glob", "Grep", "ls"]
          }
        }
      }, silentEmitter(), { abortSignal });
      input.signal?.throwIfAborted();
      plan = parseDreamPlan(extractAssistantText(getAgentThreadSDKMessages(session.threadId)));
      coordinator.submitReport({
        runId: run.runId,
        report: { status: "submitted", summary: `Reviewed ${entries.length} memories and proposed ${plan.length} Dream actions.` }
      });
      return { status: "completed", completionSummary: `Proposed ${plan.length} Dream actions.` };
    }
  });
  if (result.taskId) coordinator.finishTask({
    taskId: result.taskId,
    resolution: "accepted",
    reason: "Dream 方案已交由 MemoryCommandService 校验。"
  });
  return plan;
}

async function applyProposal(context: {
  input: RunDreamOrganizerInput;
  proposal: MemoryDreamProposal;
  evidence: DreamEvidenceItem[];
  entries: MemoryV2Entry[];
  commands: MemoryCommandService;
  store: ReturnType<typeof createMemoryV2Store>;
}): Promise<MemoryDreamResultItem[]> {
  const { input, proposal, entries, commands, store } = context;
  const cited = proposal.evidenceIds.flatMap((id) => context.evidence.find((item) => item.id === id) ?? []);
  const workspaceRefs = validatedWorkspaceEvidence(input.workspaceSlug, proposal.workspaceEvidence);
  const evidenceRefs = [...cited.map(toMemoryEvidenceRef), ...workspaceRefs];
  if (proposal.operation === "create") {
    if (!proposal.content) return [ignored(proposal, evidenceRefs, "缺少记忆内容")];
    if (!hasStrongDreamEvidence(proposal, cited)) {
      const receipt = commands.proposePending({
        workspaceSlug: input.workspaceSlug,
        content: proposal.content,
        scope: proposal.scope ?? "workspace",
        semanticRole: proposal.semanticRole,
        confidence: "low",
        facets: proposal.facets,
        claim: proposal.claim,
        evidenceRefs,
        reason: "Dream 发现了候选信息，但证据不足以自动写入。"
      });
      return [fromReceipt(receipt, "pending", proposal.reason, evidenceRefs)];
    }
    const receipt = await commands.remember({
      workspaceSlug: input.workspaceSlug,
      content: proposal.content,
      scope: proposal.scope ?? "workspace",
      semanticRole: proposal.semanticRole,
      confidence: proposal.confidence ?? "medium",
      facets: proposal.facets,
      claim: proposal.claim,
      evidenceRefs,
      actor: "consolidation"
    });
    return [fromReceipt(receipt, receipt.action === "created" ? "created" : receipt.action === "pending" ? "pending" : "ignored", proposal.reason, evidenceRefs, currentSnapshot(store, input.workspaceSlug, receipt.memoryIds[0]))];
  }
  if (proposal.operation === "replace_version") {
    const target = entries.find((entry) => entry.frontmatter.id === proposal.targetId);
    if (!target || !proposal.content) return [ignored(proposal, evidenceRefs, "缺少目标记忆或新版本内容")];
    if (!canVersion(target, proposal)) return [ignored(proposal, evidenceRefs, "新内容与目标记忆不是同一个 Claim")];
    if (!hasStrongDreamEvidence(proposal, cited)) {
      const receipt = commands.proposePending({
        workspaceSlug: input.workspaceSlug,
        content: proposal.content,
        scope: target.frontmatter.scope,
        semanticRole: target.frontmatter.semantic_role,
        confidence: "low",
        facets: proposal.facets ?? target.frontmatter.facets,
        claim: proposal.claim ?? claimFromEntry(target),
        evidenceRefs,
        existingIds: [target.frontmatter.id],
        reason: "Dream 提议更新记忆，但证据不足。"
      });
      return [fromReceipt(receipt, "pending", proposal.reason, evidenceRefs, undefined, snapshot(target))];
    }
    const explicitCorrection = proposal.explicitCorrection === true && cited.some((item) =>
      item.sourceType === "user_message" && /纠正|不对|改成|以后|现在|instead|correction|actually|now prefer/i.test(item.text)
    );
    const receipt = await commands.replaceVersion({
      workspaceSlug: input.workspaceSlug,
      id: target.frontmatter.id,
      scope: target.frontmatter.scope,
      content: proposal.content,
      claim: proposal.claim,
      confidence: proposal.confidence,
      facets: proposal.facets,
      evidenceRefs,
      explicitCorrection,
      expectedRevision: target.frontmatter.revision
    });
    const action: MemoryDreamAction = receipt.action === "superseded" ? "versioned" : receipt.action === "pending" ? "pending" : "ignored";
    return [fromReceipt(receipt, action, proposal.reason, evidenceRefs, currentSnapshot(store, input.workspaceSlug, receipt.memoryIds[0]), snapshot(target))];
  }
  if (proposal.operation === "merge") {
    const kept = entries.find((entry) => entry.frontmatter.id === proposal.keepId);
    if (!kept) return [ignored(proposal, evidenceRefs, "缺少保留记忆")];
    const results: MemoryDreamResultItem[] = [];
    for (const duplicateId of proposal.duplicateIds ?? []) {
      const duplicate = entries.find((entry) => entry.frontmatter.id === duplicateId);
      if (!duplicate || !canMerge(kept, duplicate)) {
        results.push(ignored(proposal, evidenceRefs, `记忆 ${duplicateId} 未通过重复校验`));
        continue;
      }
      const receipt = commands.mergeDuplicate({
        workspaceSlug: input.workspaceSlug,
        keptId: kept.frontmatter.id,
        duplicateId,
        scope: kept.frontmatter.scope,
        expectedKeptRevision: currentEntry(store, input.workspaceSlug, kept.frontmatter.id)?.frontmatter.revision,
        expectedDuplicateRevision: duplicate.frontmatter.revision
      });
      results.push(fromReceipt(receipt, "merged", proposal.reason, evidenceRefs, currentSnapshot(store, input.workspaceSlug, kept.frontmatter.id), snapshot(duplicate)));
    }
    return results;
  }
  const target = entries.find((entry) => entry.frontmatter.id === proposal.targetId);
  if (!target) return [ignored(proposal, evidenceRefs, "缺少目标记忆")];
  if (proposal.operation === "mark_stale") {
    const expired = Boolean(target.frontmatter.valid_to && Date.parse(target.frontmatter.valid_to) <= Date.now());
    if (!expired && !workspaceEvidenceSupportsTarget(target, workspaceRefs)) {
      return [ignored(proposal, evidenceRefs, "没有到期时间或与目标相关的工作区核验证据")];
    }
    const receipt = commands.markSuspectedStale({
      workspaceSlug: input.workspaceSlug,
      id: target.frontmatter.id,
      scope: target.frontmatter.scope,
      evidenceRefs,
      expectedRevision: target.frontmatter.revision
    });
    return [fromReceipt(receipt, receipt.action === "updated" ? "stale" : "ignored", proposal.reason, evidenceRefs, currentSnapshot(store, input.workspaceSlug, target.frontmatter.id), snapshot(target))];
  }
  if (!hasStrongDreamEvidence({ ...proposal, content: proposal.content ?? target.statement }, cited)) {
    return [ignored(proposal, evidenceRefs, "元数据更新缺少用户证据")];
  }
  const receipt = commands.update({
    workspaceSlug: input.workspaceSlug,
    id: target.frontmatter.id,
    scope: target.frontmatter.scope,
    confidence: proposal.confidence,
    facets: proposal.facets,
    validTo: proposal.validTo,
    evidenceRefs,
    expectedRevision: target.frontmatter.revision,
    actor: "consolidation"
  });
  return [fromReceipt(receipt, "updated", proposal.reason, evidenceRefs, currentSnapshot(store, input.workspaceSlug, target.frontmatter.id), snapshot(target))];
}

function buildDreamPrompt(input: RunDreamOrganizerInput, entries: MemoryV2Entry[], evidence: DreamEvidenceItem[]): string {
  const entryManifest = entries
    .sort((left, right) => Number(right.frontmatter.pinned) - Number(left.frontmatter.pinned) || right.frontmatter.updated.localeCompare(left.frontmatter.updated))
    .slice(0, MAX_ENTRY_MANIFEST_ITEMS)
    .map((entry) => ({
      id: entry.frontmatter.id,
      revision: entry.frontmatter.revision,
      scope: entry.frontmatter.scope,
      status: entry.frontmatter.status,
      semanticRole: entry.frontmatter.semantic_role,
      confidence: entry.frontmatter.confidence,
      facets: entry.frontmatter.facets,
      claim: claimFromEntry(entry),
      statement: entry.statement
    }));
  const recentSignals = evidence.filter((item) => item.sourceType !== "assistant_message").slice(0, 40).map((item) => ({
    id: item.id,
    sourceType: item.sourceType,
    threadId: item.threadId,
    runId: item.runId,
    text: item.text.slice(0, 500)
  }));
  return [
    "# Lume Dream: evidence-driven memory consolidation",
    "You are Lume's private memory Dream agent. Work in four phases: orient, gather evidence, propose consolidation, then return strict JSON.",
    "Use memory.search/read for existing memories and memory.evidence.search/read for captured conversations and tool results.",
    "You may use Read, Glob, Grep, and ls only to verify whether an existing project fact became stale. Never save facts that are directly recoverable from the current codebase.",
    "Assistant messages are context only and can never be the sole evidence. Do not propose secrets, sensitive personal data, todos, temporary plans, or model speculation.",
    "Do not write memories or files. The parent validates revisions, evidence, conflicts, and commits through MemoryCommandService.",
    "Prefer improving an existing memory over creating a near-duplicate. A conflicting inference must not be marked explicitCorrection.",
    "Return JSON only: {\"proposals\":[{\"operation\":\"create|replace_version|merge|update_metadata|mark_stale\",\"reason\":\"...\",\"scope\":\"global|workspace\",\"targetId\":\"...\",\"keepId\":\"...\",\"duplicateIds\":[\"...\"],\"content\":\"...\",\"semanticRole\":\"identity|fact|preference|constraint|decision|lesson|state\",\"confidence\":\"low|medium|high\",\"facets\":[\"...\"],\"validTo\":null,\"claim\":{\"subject\":\"...\",\"predicate\":\"...\",\"object\":\"...\",\"qualifiers\":{}},\"evidenceIds\":[\"dream-evidence:...\"],\"explicitUserStatement\":false,\"explicitCorrection\":false,\"workspaceEvidence\":[{\"path\":\"...\",\"quote\":\"...\"}]}]}",
    JSON.stringify({ workspaceSlug: input.workspaceSlug, evidenceWindow: input.evidenceWindow, entries: entryManifest, recentSignals })
  ].join("\n\n");
}

function parseDreamPlan(text: string): MemoryDreamProposal[] {
  const match = text.trim().match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Dream Agent 未返回整理方案");
  const parsed = JSON.parse(match[0]) as { proposals?: unknown };
  if (!Array.isArray(parsed.proposals)) throw new Error("Dream Agent 返回了无效整理方案");
  return parsed.proposals.flatMap(normalizeProposal);
}

function normalizeProposal(value: unknown): MemoryDreamProposal[] {
  const record = asRecord(value);
  const operation = record?.operation;
  if (!record || !isOperation(operation)) return [];
  const semanticRole = isSemanticRole(record.semanticRole) ? record.semanticRole : undefined;
  const confidence = record.confidence === "low" || record.confidence === "medium" || record.confidence === "high" ? record.confidence : undefined;
  return [{
    operation,
    reason: typeof record.reason === "string" ? record.reason : "Dream consolidation proposal",
    scope: record.scope === "global" || record.scope === "workspace" ? record.scope : undefined,
    targetId: stringValue(record.targetId),
    keepId: stringValue(record.keepId),
    duplicateIds: stringArray(record.duplicateIds),
    content: stringValue(record.content),
    semanticRole,
    confidence,
    facets: stringArray(record.facets),
    validTo: record.validTo === null || typeof record.validTo === "string" ? record.validTo : undefined,
    claim: normalizeMemoryV2Claim(asRecord(record.claim)),
    evidenceIds: stringArray(record.evidenceIds) ?? [],
    explicitUserStatement: record.explicitUserStatement === true,
    explicitCorrection: record.explicitCorrection === true,
    workspaceEvidence: Array.isArray(record.workspaceEvidence) ? record.workspaceEvidence.flatMap((item) => {
      const evidence = asRecord(item);
      return evidence && typeof evidence.path === "string" ? [{ path: evidence.path, ...(typeof evidence.quote === "string" ? { quote: evidence.quote } : {}) }] : [];
    }) : undefined
  }];
}

function expiredEntryProposals(entries: MemoryV2Entry[]): MemoryDreamProposal[] {
  return entries.filter((entry) =>
    entry.frontmatter.status === "active"
    && entry.frontmatter.valid_to
    && Date.parse(entry.frontmatter.valid_to) <= Date.now()
  ).map((entry) => ({
    operation: "mark_stale",
    targetId: entry.frontmatter.id,
    scope: entry.frontmatter.scope,
    reason: "记忆有效期已结束。",
    evidenceIds: []
  }));
}

export function hasStrongDreamEvidence(
  proposal: Pick<MemoryDreamProposal, "content" | "explicitUserStatement">,
  evidence: DreamEvidenceItem[]
): boolean {
  const userEvidence = evidence.filter((item) => item.sourceType === "user_message");
  const distinctRuns = new Set(userEvidence.flatMap((item) => item.runId ? [item.runId] : []));
  if (distinctRuns.size >= 2) return true;
  if (!proposal.explicitUserStatement || userEvidence.length === 0 || !proposal.content) return false;
  const contentTokens = durableTokens(proposal.content);
  return userEvidence.some((item) => durableTokens(item.text).filter((token) => contentTokens.includes(token)).length >= 2);
}

function canMerge(kept: MemoryV2Entry, duplicate: MemoryV2Entry): boolean {
  if (kept.frontmatter.scope !== duplicate.frontmatter.scope || kept.frontmatter.semantic_role !== duplicate.frontmatter.semantic_role) return false;
  const keptClaim = claimFromEntry(kept);
  const duplicateClaim = claimFromEntry(duplicate);
  if (keptClaim && duplicateClaim) {
    return claimKey({ scope: kept.frontmatter.scope, claim: keptClaim, appliesWhen: kept.frontmatter.applies_when })
      === claimKey({ scope: duplicate.frontmatter.scope, claim: duplicateClaim, appliesWhen: duplicate.frontmatter.applies_when })
      && keptClaim.object.trim().toLowerCase() === duplicateClaim.object.trim().toLowerCase();
  }
  return areMemoryStatementsSimilar(kept.statement, duplicate.statement);
}

function canVersion(target: MemoryV2Entry, proposal: MemoryDreamProposal): boolean {
  const currentClaim = claimFromEntry(target);
  const nextClaim = proposal.claim;
  if (currentClaim && nextClaim) {
    return claimKey({ scope: target.frontmatter.scope, claim: currentClaim, appliesWhen: target.frontmatter.applies_when })
      === claimKey({ scope: target.frontmatter.scope, claim: nextClaim, appliesWhen: target.frontmatter.applies_when });
  }
  return areMemoryStatementsSimilar(target.statement, proposal.content ?? "");
}

function workspaceEvidenceSupportsTarget(target: MemoryV2Entry, refs: MemoryEvidenceRef[]): boolean {
  const targetTokens = durableTokens(target.statement);
  return refs.some((ref) => ref.type === "workspace_file" && durableTokens(ref.quote ?? "")
    .some((token) => targetTokens.includes(token)));
}

function validatedWorkspaceEvidence(workspaceSlug: string, values?: Array<{ path: string; quote?: string }>): MemoryEvidenceRef[] {
  const root = getAgentWorkspaceBySlug(workspaceSlug)?.projectPath;
  if (!root || !values) return [];
  return values.flatMap((value) => {
    const absolute = resolve(root, value.path);
    const quote = value.quote?.trim();
    if (!quote || !existsSync(absolute)) return [];
    try {
      const canonicalRoot = realpathSync(resolve(root));
      const canonical = realpathSync(absolute);
      const rel = relative(canonicalRoot, canonical);
      if (rel.startsWith("..") || rel === "" || isSensitivePath(canonical)) return [];
      if (!statSync(canonical).isFile() || statSync(canonical).size > 1_000_000) return [];
      const content = readFileSync(canonical, "utf-8");
      if (!content.includes(quote)) return [];
      return [{ type: "workspace_file" as const, path: canonical, quote: quote.slice(0, 240) }];
    } catch {
      return [];
    }
  });
}

function toMemoryEvidenceRef(item: DreamEvidenceItem): MemoryEvidenceRef {
  return {
    type: item.sourceType === "run_summary" ? "consolidation" : item.sourceType,
    id: item.sourceId ?? item.id,
    runId: item.runId,
    threadId: item.threadId,
    quote: item.text.slice(0, 240)
  };
}

function fromReceipt(
  receipt: Awaited<ReturnType<MemoryCommandService["remember"]>>,
  action: MemoryDreamAction,
  reason: string,
  evidenceRefs: MemoryEvidenceRef[],
  after?: MemoryMutationEntrySnapshot,
  before?: MemoryMutationEntrySnapshot
): MemoryDreamResultItem {
  return {
    action,
    memoryIds: receipt.memoryIds,
    mutationId: receipt.mutationId,
    before,
    after,
    reason,
    evidenceRefs,
    undoable: receipt.undoable
  };
}

function ignored(proposal: MemoryDreamProposal, evidenceRefs: MemoryEvidenceRef[], reason: string): MemoryDreamResultItem {
  return {
    action: "ignored",
    memoryIds: proposal.targetId ? [proposal.targetId] : [],
    reason: `${proposal.reason}；${reason}`,
    evidenceRefs,
    undoable: false
  };
}

function countActions(items: MemoryDreamResultItem[]): MemoryDreamResult["actions"] {
  const counts: MemoryDreamResult["actions"] = { created: 0, versioned: 0, updated: 0, merged: 0, stale: 0, pending: 0, ignored: 0 };
  for (const item of items) counts[item.action] += 1;
  return counts;
}

function currentEntry(store: ReturnType<typeof createMemoryV2Store>, workspaceSlug: string, id?: string): MemoryV2Entry | undefined {
  if (!id) return undefined;
  return store.listEntries({ workspaceSlug, includeStatuses: ["active", "suspected_stale", "superseded", "archived"] })
    .find((entry) => entry.frontmatter.id === id);
}

function currentSnapshot(store: ReturnType<typeof createMemoryV2Store>, workspaceSlug: string, id?: string): MemoryMutationEntrySnapshot | undefined {
  const entry = currentEntry(store, workspaceSlug, id);
  return entry ? snapshot(entry) : undefined;
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
    validFrom: entry.frontmatter.valid_from ?? undefined,
    validTo: entry.frontmatter.valid_to ?? undefined,
    supersedes: entry.frontmatter.supersedes,
    supersededBy: entry.frontmatter.superseded_by ?? undefined
  };
}

function extractAssistantText(messages: SDKMessage[]): string {
  const chunks: string[] = [];
  for (const message of messages) {
    const record = message as unknown as Record<string, unknown>;
    if (message.type === "assistant") {
      const content = asRecord(record.message)?.content;
      if (Array.isArray(content)) chunks.push(...content.flatMap((block) => {
        const value = asRecord(block);
        return value?.type === "text" && typeof value.text === "string" ? [value.text] : [];
      }));
    }
    if (message.type === "result" && typeof record.result === "string") chunks.push(record.result);
  }
  return chunks.join("\n").trim();
}

function silentEmitter() {
  return {
    onComplete: () => undefined,
    onError: () => undefined,
    onTitleUpdated: () => undefined,
    onAskUserQuestion: (_request: AgentAskUserQuestionRequest) => undefined,
    onToolPermissionRequest: (_request: AgentToolPermissionRequest) => undefined
  };
}

function durableTokens(value: string): string[] {
  const normalized = value.toLowerCase();
  const wordTokens = normalized.match(/[a-z0-9]{2,}/g) ?? [];
  const cjkTokens = (normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []).flatMap((run) =>
    Array.from({ length: run.length - 1 }, (_, index) => run.slice(index, index + 2))
  );
  return [...new Set([...wordTokens, ...cjkTokens])]
    .filter((token) => !["this", "that", "with", "have", "用户", "记忆", "信息"].includes(token));
}

function isSensitivePath(path: string): boolean {
  return /(^|[\\/])(?:\.env(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)$)|\.(?:pem|key|p12|pfx)$/i.test(path);
}

function isOperation(value: unknown): value is DreamProposalOperation {
  return value === "create" || value === "replace_version" || value === "merge" || value === "update_metadata" || value === "mark_stale";
}

function isSemanticRole(value: unknown): value is MemoryV2SemanticRole {
  return value === "identity" || value === "fact" || value === "preference" || value === "constraint" || value === "decision" || value === "lesson" || value === "state";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
