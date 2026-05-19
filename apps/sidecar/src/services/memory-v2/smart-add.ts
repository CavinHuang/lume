import { createMemoryV2Store, type MemoryV2Store } from "./markdown-store";
import type {
  MemoryV2Candidate,
  MemoryV2Entry,
  MemoryV2SmartAddResult
} from "./types";

export function shouldSuppressDurableMemory(text: string): boolean {
  return /\bdo not remember\b|\bdon't remember\b|\bdo not save\b|不要记住|别记住|不要保存/i.test(text);
}

export function smartAddMemoryV2Candidate(input: {
  workspaceSlug?: string;
  candidate: MemoryV2Candidate;
  store?: MemoryV2Store;
}): MemoryV2SmartAddResult {
  const store = input.store ?? createMemoryV2Store();
  const statement = input.candidate.statement.trim();
  if (!statement) {
    return { action: "suppressed", reason: "Empty memory candidate." };
  }
  if (shouldSuppressDurableMemory(statement)) {
    return { action: "suppressed", reason: "User requested that this content not be remembered." };
  }

  const candidate = {
    ...input.candidate,
    statement,
    appliesWhen: {
      ...(input.candidate.appliesWhen ?? {}),
      ...(input.candidate.targetScope === "workspace" && input.workspaceSlug
        ? { workspaceSlug: input.workspaceSlug }
        : {})
    }
  };
  const existing = store.listEntries({
    workspaceSlug: input.workspaceSlug,
    scopes: [candidate.targetScope],
    includeStatuses: ["active", "suspected_stale"]
  });
  const duplicate = existing.find((entry) => normalizeStatement(entry.statement) === normalizeStatement(candidate.statement));
  if (duplicate) {
    return {
      action: "duplicate",
      existingIds: [duplicate.frontmatter.id],
      reason: "Candidate duplicates an active memory."
    };
  }

  const lowConfidence = candidate.confidence === "low";
  if (lowConfidence) {
    return {
      action: "low_confidence",
      pending: store.writePending({
        type: "low-confidence",
        candidate,
        reason: "Candidate confidence is below the durable memory threshold."
      }),
      reason: "Candidate routed to low-confidence review."
    };
  }

  const related = findRelatedEntries(candidate, existing);
  const conflict = related.find((entry) => looksConflicting(candidate.statement, entry.statement));
  if (conflict) {
    return {
      action: "conflict",
      existingIds: [conflict.frontmatter.id],
      pending: store.writePending({
        type: "conflict",
        candidate,
        existingIds: [conflict.frontmatter.id],
        reason: "Candidate appears to conflict with active memory."
      }),
      reason: "Candidate routed to conflict review."
    };
  }

  const staleTarget = related.find((entry) => looksStaleChange(candidate.statement, entry.statement));
  if (staleTarget) {
    store.updateEntryStatus({
      scope: staleTarget.frontmatter.scope,
      workspaceSlug: input.workspaceSlug,
      id: staleTarget.frontmatter.id,
      status: "suspected_stale"
    });
    return {
      action: "suspected_stale",
      existingIds: [staleTarget.frontmatter.id],
      pending: store.writePending({
        type: "stale",
        candidate,
        existingIds: [staleTarget.frontmatter.id],
        reason: "Candidate may change the applicability of an active memory."
      }),
      reason: "Existing memory marked suspected_stale."
    };
  }

  const entry = store.writeEntry(candidate, {
    related: related.map((item) => item.frontmatter.id)
  });
  return {
    action: related.length > 0 ? "related" : "new",
    entry,
    existingIds: related.map((item) => item.frontmatter.id),
    reason: related.length > 0 ? "Candidate stored with related memory links." : "Candidate stored as active memory."
  };
}

function findRelatedEntries(candidate: MemoryV2Candidate, entries: MemoryV2Entry[]): MemoryV2Entry[] {
  const candidateEntities = new Set((candidate.entities ?? []).map(normalizeToken));
  const candidateTags = new Set((candidate.tags ?? []).map(normalizeToken));
  const candidateTokens = new Set(tokenize(candidate.statement));
  return entries.filter((entry) => {
    if (entry.frontmatter.kind !== candidate.kind) return false;
    const sharesEntity = entry.frontmatter.entities.some((entity) => candidateEntities.has(normalizeToken(entity)));
    const sharesTag = entry.frontmatter.tags.some((tag) => candidateTags.has(normalizeToken(tag)));
    const overlap = tokenize(entry.statement).filter((token) => candidateTokens.has(token)).length;
    return sharesEntity || sharesTag || overlap >= 3;
  });
}

function looksConflicting(candidate: string, existing: string): boolean {
  const c = candidate.toLowerCase();
  const e = existing.toLowerCase();
  const oppositeSignals: Array<[string, string]> = [
    ["prefer", "do not prefer"],
    ["automatic", "manual"],
    ["auto", "confirm"],
    ["yes", "no"],
    ["enable", "disable"],
    ["开启", "关闭"],
    ["自动", "确认"],
    ["需要", "不需要"],
    ["喜欢", "不喜欢"]
  ];
  return oppositeSignals.some(([a, b]) => (c.includes(a) && e.includes(b)) || (c.includes(b) && e.includes(a)));
}

function looksStaleChange(candidate: string, existing: string): boolean {
  const c = candidate.toLowerCase();
  const e = existing.toLowerCase();
  const staleSignals = /recently moved|moved to|relocated|搬家|搬到|迁到|改成|现在|recently|最新/.test(c);
  if (!staleSignals) return false;
  const existingHasTimeOrPlace = /\bminutes?\b|\bhours?\b|\bfrom\b|\bto\b|分钟|小时|北京|上海|天津|公司|office|home/.test(e);
  return existingHasTimeOrPlace;
}

function normalizeStatement(value: string): string {
  return tokenize(value).join(" ");
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}
