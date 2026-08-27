import {
  isClaimMatchForQuery,
  planMemoryV2Query,
  type MemoryV2QueryPlan
} from "./claim";
import { areMemoryStatementsSimilar } from "./dedupe";
import { isConversationHistory } from "./recall-items";
import type { MemoryV2RecallItem } from "./types";

export function selectMemoryV2PromptItems(input: {
  items: MemoryV2RecallItem[];
  query: string;
  maxItems?: number;
  tokenBudget?: number;
}): MemoryV2RecallItem[] {
  const queryPlan = planMemoryV2Query(input.query);
  const hasMatchingClaim = input.items.some((item) => isClaimMatchForQuery(item, queryPlan));
  const historyLimit = queryPlan.includeConversationHistory ? 2 : queryPlan.querySubject && !hasMatchingClaim ? 1 : 0;
  const hardCap = queryPlan.querySubject
    ? queryPlan.includeConversationHistory ? 5 : 3
    : 5;
  const maxItems = Math.max(1, Math.min(input.maxItems ?? hardCap, hardCap));
  const selected: MemoryV2RecallItem[] = [];
  let historyCount = 0;
  let estimatedTokens = 0;
  const tokenBudget = Math.max(1, Math.min(input.tokenBudget ?? 1_200, 1_200));

  for (const item of sortForPromptSelection(input.items, queryPlan)) {
    const history = isConversationHistory(item);
    if (history) {
      if (historyCount >= historyLimit) continue;
    }
    if (selected.some((existing) => shouldDedupePromptItem(existing, item))) continue;
    const itemTokens = estimateTokens(item.statement);
    if (selected.length > 0 && estimatedTokens + itemTokens > tokenBudget) continue;
    selected.push(item);
    estimatedTokens += itemTokens;
    if (history) historyCount += 1;
    if (selected.length >= maxItems) break;
  }

  return selected;
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function sortForPromptSelection(items: MemoryV2RecallItem[], queryPlan: MemoryV2QueryPlan): MemoryV2RecallItem[] {
  return [...items].sort((left, right) => {
    const priority = promptPriority(right, queryPlan) - promptPriority(left, queryPlan);
    if (priority !== 0) return priority;
    return right.score - left.score;
  });
}

function promptPriority(item: MemoryV2RecallItem, queryPlan: MemoryV2QueryPlan): number {
  let score = 0;
  if (isClaimMatchForQuery(item, queryPlan)) score += 1000;
  else if (item.claim) score += 60;
  if (item.pinned) score += 80;
  if (item.reason.includes("memory entry") || item.reason === "profile memory") score += 40;
  if (item.reason.includes("MEMORY.md") || item.reason.includes("memory brief")) score += 30;
  if (item.reason.includes("daily")) score += 10;
  if (item.reason.includes("run")) score -= 10;
  if (item.status === "suspected_stale") score -= 100;
  return score;
}

function shouldDedupePromptItem(left: MemoryV2RecallItem, right: MemoryV2RecallItem): boolean {
  if (left.id === right.id) return true;
  if (left.claim && right.claim) {
    return left.claim.subject === right.claim.subject
      && left.claim.predicate === right.claim.predicate
      && left.scope === right.scope;
  }
  if (isConversationHistory(left) && isConversationHistory(right)) {
    return areMemoryStatementsSimilar(left.statement, right.statement);
  }
  if (left.kind !== right.kind || left.scope !== right.scope) return false;
  return areMemoryStatementsSimilar(left.statement, right.statement);
}
