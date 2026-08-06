import type {
  MemoryOrganizeEntriesInput,
  MemoryOrganizeProgress,
  MemoryOrganizeEntriesResult
} from "@lume/shared";
import { type ApiType, type LLMProvider } from "@lume/agent-sdk";
import { createLogger } from "../infra/logger";
import { decryptApiKey, resolveChannelModelBinding } from "../channel/channel-manager";
import { createLazyConnectionLlmProvider } from "../model-runtime/connection-provider";
import { claimFromEntry, claimKey, claimObjectEquals } from "./claim";
import { areMemoryStatementsSimilar } from "./dedupe";
import { createMemoryV2Store } from "./markdown-store";
import { MemoryCommandService } from "./command-service";
import { getMemoryRuntimeConfig } from "./policy";
import { resolveMemoryRerankModelRef } from "./rerank";
import type {
  MemoryV2Claim,
  MemoryV2Entry,
  MemoryV2Kind,
  MemoryV2Scope,
  MemoryV2Status
} from "./types";

const log = createLogger("memory-v2.entry-organizer");

const DEFAULT_ORGANIZE_BATCH_SIZE = 40;
const MAX_ORGANIZE_AGENT_ROUNDS = 20;

type MemoryEntryOrganizerProviderFactory = (input: {
  apiType: ApiType;
  apiKey: string;
  baseURL?: string;
}) => LLMProvider;

export interface MemoryEntryOrganizeCandidate {
  id: string;
  scope: MemoryV2Scope;
  kind: MemoryV2Kind;
  status: MemoryV2Status;
  statement: string;
  tags: string[];
  entities: string[];
  appliesWhen: Record<string, string>;
  claim?: MemoryV2Claim;
}

export interface MemoryEntryOrganizePlanItem {
  keepId: string;
  duplicateIds: string[];
  reason: string;
  update?: {
    confidence?: MemoryV2Entry["frontmatter"]["confidence"];
    facets?: string[];
  };
}

export type MemoryEntryOrganizerPlanner = (
  entries: MemoryEntryOrganizeCandidate[]
) => Promise<MemoryEntryOrganizePlanItem[]>;

export interface MemoryOrganizeEntriesOptions extends MemoryOrganizeEntriesInput {
  modelRef?: string;
  organizeBatchSize?: number;
  createProvider?: MemoryEntryOrganizerProviderFactory;
  planEntries?: MemoryEntryOrganizerPlanner;
  onProgress?: (progress: MemoryOrganizeProgress) => void;
}

export async function organizeMemoryEntries(input: MemoryOrganizeEntriesOptions): Promise<MemoryOrganizeEntriesResult> {
  const store = createMemoryV2Store();
  const commands = new MemoryCommandService(store);
  const entries = store.listEntries({
    workspaceSlug: input.workspaceSlug,
    scopes: ["global", "workspace"],
    includeStatuses: ["active", "suspected_stale"]
  }).sort(compareEntriesForOrganization);

  log.info("organizeMemoryEntries started", {
    workspaceSlug: input.workspaceSlug,
    entryCount: entries.length
  });
  input.onProgress?.({
    label: "扫描已有记忆",
    scannedItems: entries.length,
    processedItems: 0,
    scannedBatches: Math.ceil(entries.length / normalizeOrganizeBatchSize(input.organizeBatchSize)),
    processedBatches: 0
  });

  const items: MemoryOrganizeEntriesResult["items"] = [];
  const supersededIds = new Set<string>();
  const updatedIds = new Set<string>();
  const staleIds = markExpiredEntries(commands, input.workspaceSlug, entries);
  const planItems = await resolveOrganizePlan(input, entries);

  for (const planItem of planItems) {
    const kept = entries.find((entry) => entry.frontmatter.id === planItem.keepId);
    if (!kept || supersededIds.has(kept.frontmatter.id)) continue;
    if (planItem.update && (planItem.update.confidence || planItem.update.facets)) {
      commands.update({
        workspaceSlug: input.workspaceSlug,
        id: kept.frontmatter.id,
        scope: kept.frontmatter.scope,
        ...(planItem.update.confidence ? { confidence: planItem.update.confidence } : {}),
        ...(planItem.update.facets ? { facets: planItem.update.facets } : {}),
        actor: "consolidation"
      });
      updatedIds.add(kept.frontmatter.id);
    }
    for (const duplicateId of planItem.duplicateIds) {
      const duplicate = entries.find((entry) => entry.frontmatter.id === duplicateId);
      if (!duplicate || supersededIds.has(duplicate.frontmatter.id)) continue;
      if (!canSupersedeEntry(kept, duplicate)) continue;
      markDuplicate({
        commands,
        workspaceSlug: input.workspaceSlug,
        kept,
        duplicate,
        reason: planItem.reason || "LLM organized this memory as a duplicate of a stronger existing memory.",
        items,
        supersededIds
      });
    }
  }

  const kept: MemoryV2Entry[] = [];

  for (const entry of entries) {
    if (supersededIds.has(entry.frontmatter.id)) continue;
    const duplicateOf = kept.find((candidate) => isDuplicateEntry(candidate, entry));
    if (!duplicateOf) {
      kept.push(entry);
      continue;
    }
    markDuplicate({
      commands,
      workspaceSlug: input.workspaceSlug,
      kept: duplicateOf,
      duplicate: entry,
      reason: "Historical memory is substantially similar to an existing active memory.",
      items,
      supersededIds
    });
  }

  const result = {
    workspaceSlug: input.workspaceSlug,
    scannedEntries: entries.length,
    keptEntries: entries.length - supersededIds.size,
    supersededDuplicates: items.length,
    updated: updatedIds.size,
    stale: staleIds.size,
    items
  };

  log.info("organizeMemoryEntries completed", {
    workspaceSlug: input.workspaceSlug,
    scannedEntries: result.scannedEntries,
    keptEntries: result.keptEntries,
    supersededDuplicates: result.supersededDuplicates,
    stale: result.stale
  });

  return result;
}

function markExpiredEntries(
  commands: MemoryCommandService,
  workspaceSlug: string,
  entries: MemoryV2Entry[]
): Set<string> {
  const staleIds = new Set<string>();
  const now = Date.now();
  for (const entry of entries) {
    if (entry.frontmatter.status !== "active" || !entry.frontmatter.valid_to) continue;
    const validTo = Date.parse(entry.frontmatter.valid_to);
    if (!Number.isFinite(validTo) || validTo > now) continue;
    commands.markSuspectedStale({
      workspaceSlug,
      id: entry.frontmatter.id,
      scope: entry.frontmatter.scope
    });
    entry.frontmatter.status = "suspected_stale";
    staleIds.add(entry.frontmatter.id);
  }
  return staleIds;
}

function markDuplicate(input: {
  commands: MemoryCommandService;
  workspaceSlug: string;
  kept: MemoryV2Entry;
  duplicate: MemoryV2Entry;
  reason: string;
  items: MemoryOrganizeEntriesResult["items"];
  supersededIds: Set<string>;
}): void {
  input.commands.supersedeDuplicate({
    scope: input.duplicate.frontmatter.scope,
    workspaceSlug: input.workspaceSlug,
    duplicateId: input.duplicate.frontmatter.id,
    keptId: input.kept.frontmatter.id
  });
  input.supersededIds.add(input.duplicate.frontmatter.id);
  input.items.push({
    keptId: input.kept.frontmatter.id,
    duplicateId: input.duplicate.frontmatter.id,
    scope: input.duplicate.frontmatter.scope,
    statement: input.kept.statement,
    duplicateStatement: input.duplicate.statement,
    action: "superseded_duplicate",
    reason: input.reason
  });
}

async function resolveOrganizePlan(
  input: MemoryOrganizeEntriesOptions,
  entries: MemoryV2Entry[]
): Promise<MemoryEntryOrganizePlanItem[]> {
  if (entries.length === 0) return [];
  const candidates = entries.map(toOrganizeCandidate);
  const batchSize = normalizeOrganizeBatchSize(input.organizeBatchSize);
  if (input.planEntries) {
    return sanitizeOrganizePlan(
      await planCandidateBatches(input.planEntries, candidates, batchSize, input.onProgress),
      candidates
    );
  }
  const planner = safeCreateLlmOrganizerPlanner(input);
  if (!planner) return [];
  try {
    return sanitizeOrganizePlan(await planCandidateBatches(planner, candidates, batchSize, input.onProgress), candidates);
  } catch {
    return [];
  }
}

async function planCandidateBatches(
  planner: MemoryEntryOrganizerPlanner,
  candidates: MemoryEntryOrganizeCandidate[],
  batchSize: number,
  onProgress?: (progress: MemoryOrganizeProgress) => void
): Promise<MemoryEntryOrganizePlanItem[]> {
  const scannedBatches = Math.max(1, Math.min(MAX_ORGANIZE_AGENT_ROUNDS, Math.ceil(candidates.length / batchSize)));
  if (candidates.length <= batchSize) {
    const plan = await planner(candidates);
    onProgress?.({
      label: "分析已有记忆",
      scannedItems: candidates.length,
      processedItems: candidates.length,
      scannedBatches,
      processedBatches: 1
    });
    return plan;
  }
  const plans: MemoryEntryOrganizePlanItem[] = [];
  let processedBatches = 0;
  for (
    let start = 0;
    start < candidates.length && processedBatches < MAX_ORGANIZE_AGENT_ROUNDS;
    start += batchSize
  ) {
    plans.push(...await planner(candidates.slice(start, start + batchSize)));
    processedBatches += 1;
    onProgress?.({
      label: "分析已有记忆",
      scannedItems: candidates.length,
      processedItems: Math.min(candidates.length, start + batchSize),
      scannedBatches,
      processedBatches
    });
  }
  return plans;
}

function normalizeOrganizeBatchSize(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value < 1) return DEFAULT_ORGANIZE_BATCH_SIZE;
  return Math.max(1, Math.floor(value));
}

function safeCreateLlmOrganizerPlanner(input: MemoryOrganizeEntriesOptions): MemoryEntryOrganizerPlanner | undefined {
  try {
    return createLlmOrganizerPlanner(input);
  } catch {
    return undefined;
  }
}

function createLlmOrganizerPlanner(input: MemoryOrganizeEntriesOptions): MemoryEntryOrganizerPlanner | undefined {
  const runtimeConfig = getMemoryRuntimeConfig();
  const resolved = resolveMemoryRerankModelRef({
    workspaceSlug: input.workspaceSlug,
    explicitModelRef: input.modelRef ?? runtimeConfig.retrieval.rerankModelRef
  });
  if (!resolved.modelRef) return undefined;
  const binding = resolveChannelModelBinding(resolved.modelRef, "chat");
  if (!binding && !input.createProvider) return undefined;
  const provider = input.createProvider
    ? input.createProvider({
      apiType: binding ? resolveOrganizerApiType(binding.channel.provider) : "openai-completions",
      apiKey: binding ? decryptApiKey(binding.channel.id) : "",
      baseURL: binding?.channel.baseUrl
    })
    : createLazyConnectionLlmProvider({ connectionId: binding!.channel.id, modelId: binding!.modelId });
  const model = binding?.modelId ?? resolved.modelRef.split("/").at(-1) ?? resolved.modelRef;
  return async (entries) => organizeEntriesWithLlm({ provider, model, entries, workspaceSlug: input.workspaceSlug });
}

async function organizeEntriesWithLlm(input: {
  provider: LLMProvider;
  model: string;
  entries: MemoryEntryOrganizeCandidate[];
  workspaceSlug: string;
}): Promise<MemoryEntryOrganizePlanItem[]> {
  const response = await input.provider.createMessage({
    model: input.model,
    maxTokens: 1200,
    system: buildOrganizerSystemPrompt(),
    messages: [{
      role: "user",
      content: buildOrganizerUserPrompt(input)
    }]
  });
  const text = response.content
    .map((block) => block.type === "text" ? block.text : "")
    .filter(Boolean)
    .join("\n");
  return parseOrganizerPlan(text);
}

function buildOrganizerSystemPrompt(): string {
  return [
    "You organize existing Lume memories by finding durable duplicate facts, preferences, decisions, lessons, or state records.",
    "Return strict JSON only with shape {\"duplicates\":[{\"keepId\":\"entry-id\",\"duplicateIds\":[\"entry-id\"],\"reason\":\"short reason\"}]}.",
    "Only mark memories as duplicates when they express the same durable meaning, not just a related topic.",
    "Prefer the clearer, more current, more complete memory as keepId.",
    "Do not create or rewrite fact statements. Only choose ids that already appear in the input.",
    "You may propose metadata updates for the keepId only when directly supported by its current statement: confidence and open facets. Never change scope, claim, or semantic role.",
    "Never mark entries with different scope or kind as duplicates.",
    "For structured claims, duplicate claims must have the same subject, predicate, appliesWhen, and object."
  ].join("\n");
}

function buildOrganizerUserPrompt(input: {
  workspaceSlug: string;
  entries: MemoryEntryOrganizeCandidate[];
}): string {
  return JSON.stringify({
    workspaceSlug: input.workspaceSlug,
    entries: input.entries,
    output: {
      duplicates: [{
        keepId: "id to keep",
        duplicateIds: ["ids to supersede"],
        reason: "why these entries are the same durable memory",
        update: {
          confidence: "low|medium|high (optional)",
          facets: ["optional open labels"]
        }
      }]
    }
  });
}

function parseOrganizerPlan(text: string): MemoryEntryOrganizePlanItem[] {
  const match = text.trim().match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as { duplicates?: unknown };
    if (!Array.isArray(parsed.duplicates)) return [];
    return parsed.duplicates
      .map((item) => normalizePlanItem(item))
      .filter((item): item is MemoryEntryOrganizePlanItem => Boolean(item));
  } catch {
    return [];
  }
}

function normalizePlanItem(value: unknown): MemoryEntryOrganizePlanItem | undefined {
  if (!isRecord(value)) return undefined;
  const keepId = typeof value.keepId === "string" ? value.keepId.trim() : "";
  const duplicateIds = Array.isArray(value.duplicateIds)
    ? value.duplicateIds
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.trim())
      .filter(Boolean)
    : [];
  const reason = typeof value.reason === "string" && value.reason.trim()
    ? value.reason.trim()
    : "LLM organized this memory as a duplicate of a stronger existing memory.";
  const update = normalizeOrganizeUpdate(value.update);
  if (!keepId || (duplicateIds.length === 0 && !update)) return undefined;
  return { keepId, duplicateIds, reason, ...(update ? { update } : {}) };
}

function normalizeOrganizeUpdate(value: unknown): MemoryEntryOrganizePlanItem["update"] | undefined {
  if (!isRecord(value)) return undefined;
  const confidence = value.confidence === "low" || value.confidence === "medium" || value.confidence === "high"
    ? value.confidence
    : undefined;
  const facets = Array.isArray(value.facets)
    ? Array.from(new Set(value.facets.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))).slice(0, 12)
    : undefined;
  if (!confidence && !facets?.length) return undefined;
  return {
    ...(confidence ? { confidence } : {}),
    ...(facets?.length ? { facets } : {})
  };
}

function sanitizeOrganizePlan(
  plan: MemoryEntryOrganizePlanItem[],
  candidates: MemoryEntryOrganizeCandidate[]
): MemoryEntryOrganizePlanItem[] {
  const ids = new Set(candidates.map((entry) => entry.id));
  const claimedDuplicates = new Set<string>();
  const sanitized: MemoryEntryOrganizePlanItem[] = [];
  for (const item of plan) {
    if (!ids.has(item.keepId)) continue;
    const duplicateIds = Array.from(new Set(item.duplicateIds))
      .filter((id) => id !== item.keepId && ids.has(id) && !claimedDuplicates.has(id));
    if (duplicateIds.length === 0 && !item.update) continue;
    duplicateIds.forEach((id) => claimedDuplicates.add(id));
    sanitized.push({
      keepId: item.keepId,
      duplicateIds,
      reason: item.reason,
      ...(item.update ? { update: item.update } : {})
    });
  }
  return sanitized;
}

function toOrganizeCandidate(entry: MemoryV2Entry): MemoryEntryOrganizeCandidate {
  const claim = claimFromEntry(entry);
  return {
    id: entry.frontmatter.id,
    scope: entry.frontmatter.scope,
    kind: entry.frontmatter.kind,
    status: entry.frontmatter.status,
    statement: entry.statement,
    tags: entry.frontmatter.tags,
    entities: entry.frontmatter.entities,
    appliesWhen: entry.frontmatter.applies_when,
    ...(claim ? { claim } : {})
  };
}

function isDuplicateEntry(left: MemoryV2Entry, right: MemoryV2Entry): boolean {
  if (!canSupersedeEntry(left, right)) return false;
  return areMemoryStatementsSimilar(left.statement, right.statement);
}

function canSupersedeEntry(left: MemoryV2Entry, right: MemoryV2Entry): boolean {
  if (left.frontmatter.scope !== right.frontmatter.scope) return false;
  if (left.frontmatter.kind !== right.frontmatter.kind) return false;
  const leftClaim = claimFromEntry(left);
  const rightClaim = claimFromEntry(right);
  if (leftClaim || rightClaim) {
    if (!leftClaim || !rightClaim) return false;
    return claimKey({
      scope: left.frontmatter.scope,
      claim: leftClaim,
      appliesWhen: left.frontmatter.applies_when
    }) === claimKey({
      scope: right.frontmatter.scope,
      claim: rightClaim,
      appliesWhen: right.frontmatter.applies_when
    }) && claimObjectEquals(leftClaim, rightClaim);
  }
  return true;
}

function compareEntriesForOrganization(left: MemoryV2Entry, right: MemoryV2Entry): number {
  const created = left.frontmatter.created.localeCompare(right.frontmatter.created);
  if (created !== 0) return created;
  return left.path.localeCompare(right.path);
}

function resolveOrganizerApiType(provider: string): ApiType {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "anthropic-compatible") return "anthropic-messages";
  if (normalized === "deepseek") return "deepseek-chat-completions";
  return "openai-completions";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
