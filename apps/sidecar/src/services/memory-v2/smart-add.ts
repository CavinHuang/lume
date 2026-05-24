import { createMemoryV2Store, type MemoryV2Store } from "./markdown-store";
import { createMemoryV2EmbeddingProvider, type MemoryV2EmbedTexts } from "./embedding";
import type {
  MemoryV2Candidate,
  MemoryV2Entry,
  MemoryV2SmartAddResult
} from "./types";
import { isPreferredNameMemory } from "./profile";
import {
  claimFromEntry,
  claimKey,
  claimObjectEquals,
  inferMemoryV2Claim,
  normalizeMemoryV2Claim
} from "./claim";
import { areMemoryStatementsSimilar, memoryTextFingerprint, memoryTextTokens } from "./dedupe";

export function shouldSuppressDurableMemory(text: string): boolean {
  return /\bdo not remember\b|\bdon't remember\b|\bdo not save\b|不要记住|别记住|不要保存/i.test(text);
}

export async function smartAddMemoryV2Candidate(input: {
  workspaceSlug?: string;
  candidate: MemoryV2Candidate;
  store?: MemoryV2Store;
  embedTexts?: MemoryV2EmbedTexts;
}): Promise<MemoryV2SmartAddResult> {
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
    },
    claim: normalizeMemoryV2Claim(input.candidate.claim) ?? inferMemoryV2Claim({
      statement,
      tags: input.candidate.tags
    })
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
  const claimMatch = candidate.claim
    ? existing.find((entry) => claimKey({
      scope: candidate.targetScope,
      claim: candidate.claim!,
      appliesWhen: candidate.appliesWhen
    }) === claimKey({
      scope: entry.frontmatter.scope,
      claim: claimFromEntry(entry) ?? candidate.claim!,
      appliesWhen: entry.frontmatter.applies_when
    }) && claimFromEntry(entry))
    : undefined;
  if (claimMatch) {
    const existingClaim = claimFromEntry(claimMatch)!;
    if (claimObjectEquals(candidate.claim!, existingClaim)) {
      return {
        action: "duplicate",
        existingIds: [claimMatch.frontmatter.id],
        reason: "Candidate duplicates an active claim memory."
      };
    }
    return {
      action: "conflict",
      existingIds: [claimMatch.frontmatter.id],
      pending: store.writePending({
        type: "conflict",
        candidate,
        existingIds: [claimMatch.frontmatter.id],
        reason: "Candidate changes an active claim memory."
      }),
      reason: "Claim memory routed to conflict review."
    };
  }

  const similarDuplicate = existing.find((entry) => isSimilarDuplicate(candidate, entry));
  if (similarDuplicate) {
    return {
      action: "duplicate",
      existingIds: [similarDuplicate.frontmatter.id],
      reason: "Candidate is substantially similar to an active memory."
    };
  }
  const semanticDuplicate = await findSemanticDuplicate({
    candidate,
    entries: existing,
    embedTexts: input.embedTexts ?? createMemoryV2EmbeddingProvider(input.workspaceSlug, {
      includeImplicitLocal: false
    })
  });
  if (semanticDuplicate) {
    return {
      action: "duplicate",
      existingIds: [semanticDuplicate.frontmatter.id],
      reason: "Candidate is semantically similar to an active memory."
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
  const preferredNameConflict = related.find((entry) =>
    !hasDifferentClaimKey(candidate, entry)
    &&
    isPreferredNameMemory({ tags: candidate.tags, statement: candidate.statement })
    && isPreferredNameMemory({ tags: entry.frontmatter.tags, statement: entry.statement })
    && normalizeStatement(entry.statement) !== normalizeStatement(candidate.statement)
  );
  if (preferredNameConflict) {
    return {
      action: "conflict",
      existingIds: [preferredNameConflict.frontmatter.id],
      pending: store.writePending({
        type: "conflict",
        candidate,
        existingIds: [preferredNameConflict.frontmatter.id],
        reason: "Candidate changes the user's preferred name."
      }),
      reason: "Preferred-name memory routed to conflict review."
    };
  }
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
  for (const relatedEntry of related) {
    store.updateEntryRelations({
      scope: relatedEntry.frontmatter.scope,
      workspaceSlug: relatedEntry.frontmatter.scope === "workspace" ? input.workspaceSlug : undefined,
      id: relatedEntry.frontmatter.id,
      related: [entry.frontmatter.id]
    });
  }
  return {
    action: related.length > 0 ? "related" : "new",
    entry,
    existingIds: related.map((item) => item.frontmatter.id),
    reason: related.length > 0 ? "Candidate stored with related memory links." : "Candidate stored as active memory."
  };
}

async function findSemanticDuplicate(input: {
  candidate: MemoryV2Candidate;
  entries: MemoryV2Entry[];
  embedTexts?: MemoryV2EmbedTexts;
}): Promise<MemoryV2Entry | undefined> {
  if (!input.embedTexts) return undefined;
  const comparable = input.entries.filter((entry) =>
    !hasDifferentClaimKey(input.candidate, entry)
    && entry.frontmatter.kind === input.candidate.kind
  );
  if (comparable.length === 0) return undefined;
  try {
    const vectors = await input.embedTexts([
      input.candidate.statement,
      ...comparable.map((entry) => entry.statement)
    ]);
    const candidateVector = vectors[0];
    if (!candidateVector || candidateVector.length === 0) return undefined;
    let best: { entry: MemoryV2Entry; score: number } | undefined;
    for (let index = 0; index < comparable.length; index += 1) {
      const entryVector = vectors[index + 1];
      if (!entryVector || entryVector.length === 0) continue;
      const score = cosineSimilarity(candidateVector, entryVector);
      if (!best || score > best.score) best = { entry: comparable[index]!, score };
    }
    return best && best.score >= 0.92 ? best.entry : undefined;
  } catch {
    return undefined;
  }
}

function hasDifferentClaimKey(candidate: MemoryV2Candidate, entry: MemoryV2Entry): boolean {
  if (!candidate.claim) return false;
  const entryClaim = claimFromEntry(entry);
  if (!entryClaim) return false;
  return claimKey({
    scope: candidate.targetScope,
    claim: candidate.claim,
    appliesWhen: candidate.appliesWhen
  }) !== claimKey({
    scope: entry.frontmatter.scope,
    claim: entryClaim,
    appliesWhen: entry.frontmatter.applies_when
  });
}

function findRelatedEntries(candidate: MemoryV2Candidate, entries: MemoryV2Entry[]): MemoryV2Entry[] {
  const candidateEntities = new Set((candidate.entities ?? []).map(normalizeToken));
  const candidateTags = new Set((candidate.tags ?? []).map(normalizeToken));
  const candidateTokens = new Set(memoryTextTokens(candidate.statement));
  return entries.filter((entry) => {
    if (hasDifferentClaimKey(candidate, entry)) return false;
    if (entry.frontmatter.kind !== candidate.kind) return false;
    const sharesEntity = entry.frontmatter.entities.some((entity) => candidateEntities.has(normalizeToken(entity)));
    const sharesTag = entry.frontmatter.tags.some((tag) => candidateTags.has(normalizeToken(tag)));
    const overlap = memoryTextTokens(entry.statement).filter((token) => candidateTokens.has(token)).length;
    return sharesEntity || sharesTag || overlap >= 3;
  });
}

function isSimilarDuplicate(candidate: MemoryV2Candidate, entry: MemoryV2Entry): boolean {
  if (hasDifferentClaimKey(candidate, entry)) return false;
  if (entry.frontmatter.kind !== candidate.kind) return false;
  return areMemoryStatementsSimilar(candidate.statement, entry.statement);
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
  return memoryTextFingerprint(value);
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    dot += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}
