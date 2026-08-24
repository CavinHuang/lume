import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getMemoryV2ScopePaths } from "./paths";
import { createMemoryV2Store, readActivation, type MemoryV2Store } from "./markdown-store";
import {
  LOCAL_ONNX_MEMORY_EMBEDDING_MODEL_REF,
  createMemoryV2EmbeddingAttempts,
  resolveMemoryEmbeddingModelRef,
  type MemoryV2EmbeddingAttempt,
  type MemoryV2EmbedTexts
} from "./embedding";
import { getLocalOnnxMemoryEmbeddingStatus } from "./local-embedding";
import { createMemoryV2QueryPlanner, type MemoryV2PlanQuery } from "./query-planner";
import { createMemoryV2Reranker, type MemoryV2RerankItems } from "./rerank";
import { searchSemanticRecall } from "./semantic-index";
import { getMemoryRuntimeConfig } from "./policy";
import { getEffectiveLumeConfig } from "../system/lume-config-service";
import {
  claimFromEntry,
  isClaimMatchForQuery,
  planMemoryV2Query,
  sortClaimMatchesFirst,
  type MemoryV2QueryPlan
} from "./claim";
import type {
  MemoryV2Entry,
  MemoryV2RecallItem,
  MemoryV2Scope,
  MemoryV2SemanticRole
} from "./types";
import { MemoryCommandService } from "./command-service";

export interface MemoryV2SearchInput {
  workspaceSlug?: string;
  query: string;
  maxResults?: number;
  scopes?: MemoryV2Scope[];
  intent?: MemoryV2SearchIntent;
  includeRecentDaily?: boolean;
  store?: MemoryV2Store;
  semantic?: "auto" | "off";
  embedTexts?: MemoryV2EmbedTexts;
  embeddingAttempts?: MemoryV2EmbeddingAttempt[];
  rerankItems?: MemoryV2RerankItems;
  queryPlan?: MemoryV2QueryPlan;
  queryPlanner?: MemoryV2PlanQuery;
}

export type MemoryV2SearchIntent =
  | "architecture"
  | "continue_task"
  | "identity"
  | "preference"
  | "debug"
  | "commit"
  | "general";

/** rerank 候选池相对 top-N 的放宽倍数：截断发生在 rerank 之后而非之前（#521）。 */
const RERANK_CANDIDATE_MULTIPLIER = 3;

export async function searchMemoryV2(input: MemoryV2SearchInput): Promise<MemoryV2RecallItem[]> {
  const store = input.store ?? createMemoryV2Store();
  const query = input.query.trim();
  if (!query) return [];
  const runtimeConfig = getMemoryRuntimeConfig();
  const intent = input.intent ?? inferSearchIntent(query);
  const queryPlanner = input.queryPlanner ?? createMemoryV2QueryPlanner({
    workspaceSlug: input.workspaceSlug,
    modelRef: runtimeConfig.retrieval.rerankModelRef
  });
  const queryPlan = input.queryPlan ?? await resolveMemoryV2QueryPlan(query, queryPlanner);
  const scopes = input.scopes ?? (input.workspaceSlug ? ["global", "workspace"] : ["global"]);
  const loadedEntries = store.listEntries({
      workspaceSlug: input.workspaceSlug,
      scopes,
      includeStatuses: ["active", "suspected_stale"]
    });
  expireEntries(loadedEntries, input.workspaceSlug);
  const entryCandidates = entryRecallCandidates(
    loadedEntries.filter((entry) => readActivation(entry.frontmatter).recall)
      .filter((entry) => !currentMessageOverridesClaim(entry, query, queryPlan))
  );
  const scoredEntries = scoreRecallCandidates(entryCandidates, query, intent, queryPlan);
  const hasExactClaimMatch = scoredEntries.some((item) => isClaimMatchForQuery(item, queryPlan));
  const candidates = [
    ...entryCandidates,
    ...markdownRecallCandidates({
      workspaceSlug: input.workspaceSlug,
      scopes,
      includeRecentDaily: input.includeRecentDaily ?? (!hasExactClaimMatch || queryPlan.includeConversationHistory)
    })
  ];
  const semanticCandidates = candidates.filter((item) => shouldKeepCandidateForQueryPlan(item, queryPlan));
  const scored = [
    ...scoredEntries,
    ...scoreRecallCandidates(candidates.slice(entryCandidates.length), query, intent, queryPlan)
  ];
  const semantic = await maybeSemanticRecall({
    input,
    query,
    candidates: semanticCandidates,
    semantic: input.semantic ?? runtimeConfig.retrieval.semantic,
    maxResults: input.maxResults ?? 5,
    hasBaseRecall: scored.length > 0
  });
  const maxResults = input.maxResults ?? 5;
  // 预截断放宽 N×3 给 rerank 候选池:否则 rerank 收到的就是 ≤N 条恒等置换,
  // 连"谁进 top-N"都无法参与,LLM 调用产出近乎完全作废(#521)
  const merged = mergeRecallItems([...scored, ...semantic])
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults * RERANK_CANDIDATE_MULTIPLIER);
  const reranker = input.rerankItems ?? createMemoryV2Reranker({
    workspaceSlug: input.workspaceSlug,
    modelRef: runtimeConfig.retrieval.rerankModelRef
  });
  if (!reranker) return sortClaimMatchesFirst(merged.slice(0, maxResults), queryPlan);
  try {
    const reranked = await reranker(merged, query);
    // 以返回序号覆写 score:下游三级比较器(claim→predicate→score)的平分组内
    // 由此收敛到 rerank 序,而非 rerank 前的旧 score(#521)
    const scoredByRerank = reranked.map((item, index) => ({ ...item, score: reranked.length - index }));
    return sortClaimMatchesFirst(scoredByRerank.slice(0, maxResults), queryPlan);
  } catch {
    return sortClaimMatchesFirst(merged.slice(0, maxResults), queryPlan);
  }
}

function shouldKeepCandidateForQueryPlan(item: MemoryV2RecallItem, queryPlan: MemoryV2QueryPlan): boolean {
  if (!item.claim || !queryPlan.querySubject || queryPlan.desiredPredicates.length === 0) return true;
  return isClaimMatchForQuery(item, queryPlan);
}

async function resolveMemoryV2QueryPlan(
  query: string,
  planner?: MemoryV2PlanQuery
): Promise<MemoryV2QueryPlan> {
  const fallback = planMemoryV2Query(query);
  if (!planner) return fallback;
  try {
    return mergeMemoryV2QueryPlans(fallback, await planner(query));
  } catch {
    return fallback;
  }
}

function mergeMemoryV2QueryPlans(
  fallback: MemoryV2QueryPlan,
  planned?: MemoryV2QueryPlan
): MemoryV2QueryPlan {
  if (!planned) return fallback;
  return {
    querySubject: planned.querySubject ?? fallback.querySubject,
    desiredPredicates: mergePredicates(fallback.desiredPredicates, planned.desiredPredicates),
    includeConversationHistory: fallback.includeConversationHistory || planned.includeConversationHistory
  };
}

function mergePredicates(left: string[], right: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const predicate of [...left, ...right]) {
    const normalized = predicate.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    merged.push(predicate);
  }
  return merged;
}

export function inferSearchIntent(query: string): MemoryV2SearchIntent {
  const text = query.toLowerCase();
  if (/architecture|design|boundary|架构|设计|边界/.test(text)) return "architecture";
  if (/continue|next|todo|state|recent|current|now|继续|下一步|进度|状态|最近|当前|现在|刚才|干嘛|做什么|做到哪|进展/.test(text)) return "continue_task";
  if (/who am i|who are you|what'?s my name|what is my name|what'?s your name|what is your name|call me|my name|your name|我是谁|你是谁|我叫什么|你叫什么|我的名字|你的名字|叫我什么|怎么称呼|称呼我|称呼你|名字/.test(text)) return "identity";
  if (/prefer|preference|rule|habit|偏好|习惯|规则/.test(text)) return "preference";
  if (/debug|error|fail|bug|报错|失败|修复/.test(text)) return "debug";
  if (/commit|push|pr|提交|推送/.test(text)) return "commit";
  return "general";
}

function entryRecallCandidates(entries: MemoryV2Entry[]): MemoryV2RecallItem[] {
  return entries.map((entry) => ({
    id: entry.frontmatter.id,
    kind: entry.frontmatter.kind,
    semanticRole: entry.frontmatter.semantic_role,
    scope: entry.frontmatter.scope,
    status: entry.frontmatter.status === "suspected_stale" ? "suspected_stale" : "active",
    statement: entry.statement,
    path: entry.path,
    citation: entry.path,
    reason: entry.frontmatter.pinned ? "pinned memory" : "matched memory entry",
    score: 0,
    pinned: entry.frontmatter.pinned,
    tags: entry.frontmatter.tags,
    claim: claimFromEntry(entry)
  }));
}

function markdownRecallCandidates(input: {
  workspaceSlug?: string;
  scopes: MemoryV2Scope[];
  includeRecentDaily: boolean;
}): MemoryV2RecallItem[] {
  const items: MemoryV2RecallItem[] = [];
  for (const scope of input.scopes) {
    if (scope === "workspace" && !input.workspaceSlug) continue;
    const paths = getMemoryV2ScopePaths({ scope, workspaceSlug: input.workspaceSlug });
    if (existsSync(paths.memoryMd)) {
      const text = readFileSync(paths.memoryMd, "utf-8").trim();
      if (text) {
        items.push({
          id: `${scope}:MEMORY.md`,
          kind: "state",
          semanticRole: "state",
          scope,
          status: "active",
          statement: text,
          path: paths.memoryMd,
          citation: paths.memoryMd,
          reason: `${scope} memory brief`,
          score: 0,
          pinned: true
        });
      }
    }
    if (input.includeRecentDaily) {
      for (const path of recentDailyFiles(paths.dailyDir, 2)) {
        const text = readFileSync(path, "utf-8").trim();
        if (!text) continue;
        items.push({
          id: `${scope}:daily:${path}`,
          kind: "state",
          semanticRole: "state",
          scope,
          status: "active",
          statement: text,
          path,
          citation: path,
          reason: "recent daily memory",
          score: 0
        });
      }
      if (scope === "workspace") {
        for (const path of recentRunFiles(paths.runsDir, 2)) {
          const text = readFileSync(path, "utf-8").trim();
          if (!text) continue;
          items.push({
            id: `${scope}:run:${path}`,
            kind: "state",
            semanticRole: "state",
            scope,
            status: "active",
            statement: text,
            path,
            citation: path,
            reason: "recent run memory",
            score: 0
          });
        }
      }
    }
    if (scope === "workspace" && existsSync(paths.workspaceBrief)) {
      const text = readFileSync(paths.workspaceBrief, "utf-8").trim();
      if (text) items.push({
        id: "workspace:brief",
        kind: "state",
        semanticRole: "state",
        scope,
        status: "active",
        statement: text,
        path: paths.workspaceBrief,
        citation: paths.workspaceBrief,
        reason: "workspace memory brief",
        score: 0,
        pinned: true
      });
    }
    if (scope === "workspace") {
      const capsule = recentFiles(paths.capsulesDir, 1, /\.md$/)[0];
      if (capsule) {
        const text = readFileSync(capsule, "utf-8").trim();
        if (text) items.push({
          id: `workspace:capsule:${capsule}`,
          kind: "state",
          semanticRole: "state",
          scope,
          status: "active",
          statement: text,
          path: capsule,
          citation: capsule,
          reason: "workspace topic capsule",
          score: 0
        });
      }
    }
  }
  return items;
}

function expireEntries(entries: MemoryV2Entry[], workspaceSlug?: string): void {
  const now = Date.now();
  const service = new MemoryCommandService();
  for (const entry of entries) {
    if (entry.frontmatter.status !== "active" || !entry.frontmatter.valid_to) continue;
    const expiresAt = Date.parse(entry.frontmatter.valid_to);
    if (!Number.isFinite(expiresAt) || expiresAt > now) continue;
    try {
      service.markSuspectedStale({
        workspaceSlug: workspaceSlug ?? "",
        id: entry.frontmatter.id,
        scope: entry.frontmatter.scope
      });
      entry.frontmatter.status = "suspected_stale";
    } catch {
      continue;
    }
  }
}

function currentMessageOverridesClaim(entry: MemoryV2Entry, query: string, queryPlan: MemoryV2QueryPlan): boolean {
  const claim = claimFromEntry(entry);
  if (!claim || !/(?:纠正|改为|改成|不是|不再|instead|actually|from now on)/i.test(query)) return false;
  // #521:"不是/不再/actually"是日常高频词,普通疑问句即可误触。抑制需同时满足:
  // predicate 命中计划口径(isClaimMatchForQuery 同款归一化)+ claim.subject 与
  // 计划主体一致(跨主体保护:纠正用户名不得抑制 assistant 名字记忆)。
  // 注意不能拿 queryPlan.querySubject 对 query 原文做字面匹配——它是 "user/self"
  // 型 slug,自然语言永远不包含,写了等于全灭。
  const normalizedPredicate = claim.predicate.trim().toLowerCase();
  if (!normalizedPredicate) return false;
  if (!queryPlan.desiredPredicates.some((planned) => planned.trim().toLowerCase() === normalizedPredicate)) {
    return false;
  }
  if (queryPlan.querySubject && claim.subject.trim().toLowerCase() !== queryPlan.querySubject.trim().toLowerCase()) {
    return false;
  }
  return !query.toLowerCase().includes(claim.object.toLowerCase());
}

function scoreRecallCandidates(
  candidates: MemoryV2RecallItem[],
  query: string,
  intent: MemoryV2SearchIntent,
  queryPlan: MemoryV2QueryPlan
): MemoryV2RecallItem[] {
  return candidates
    .map((item) => ({
      item,
      score: scoreRecallItem(item, query, intent, queryPlan)
    }))
    .filter(({ item, score }) => {
      if (item.status === "suspected_stale") return score >= 7;
      return score > 0;
    })
    .map(({ item, score }) => ({ ...item, score }));
}

function scoreRecallItem(
  item: MemoryV2RecallItem,
  query: string,
  intent: MemoryV2SearchIntent,
  queryPlan: MemoryV2QueryPlan
): number {
  const claimScore = isClaimMatchForQuery(item, queryPlan) ? 100 : 0;
  if (item.claim && queryPlan.querySubject && queryPlan.desiredPredicates.length > 0 && claimScore === 0) {
    return 0;
  }
  const queryTokens = new Set(tokenize(query));
  const itemTokens = tokenize(`${item.statement} ${item.path}`);
  const lexical = itemTokens.reduce((score, token) => score + (queryTokens.has(token) ? 1 : 0), 0);
  const semanticScore = semanticIntentBoost(item, intent);
  const historyScore = queryPlan.includeConversationHistory && isConversationHistoryRecallItem(item) ? 3 : 0;
  const kindScore = roleIntentBoost(item.semanticRole, intent);
  if (claimScore === 0 && lexical === 0 && semanticScore === 0 && historyScore === 0 && kindScore === 0 && !item.pinned) return 0;
  const pathScore = [...queryTokens].some((token) => item.path.toLowerCase().includes(token)) ? 1.5 : 0;
  const pinnedScore = item.pinned ? 2 : 0;
  const scopeScore = item.scope === "workspace" ? 1 : 0.5;
  const stalePenalty = item.status === "suspected_stale" ? -3 : 0;
  return claimScore + lexical + semanticScore + historyScore + pathScore + pinnedScore + scopeScore + kindScore + stalePenalty;
}

function isConversationHistoryRecallItem(item: MemoryV2RecallItem): boolean {
  return item.reason === "recent daily memory"
    || item.reason === "recent run memory"
    || item.id.includes(":daily:")
    || item.id.includes(":run:");
}

// identity/constraint 继承 fact 分值：legacyKindForRole 曾把它们压缩成 fact，
// 保持存量排序语义不变；按 role 细分调分待评测度量（#298）后再做。
function roleIntentBoost(role: MemoryV2SemanticRole, intent: MemoryV2SearchIntent): number {
  const boosts: Record<MemoryV2SearchIntent, Partial<Record<MemoryV2SemanticRole, number>>> = {
    architecture: { decision: 3, fact: 2, lesson: 2, identity: 2, constraint: 2 },
    continue_task: { state: 3, decision: 1 },
    identity: { preference: 3, fact: 2, identity: 2, constraint: 2 },
    preference: { preference: 3 },
    debug: { lesson: 3, fact: 1, identity: 1, constraint: 1 },
    commit: { preference: 2, fact: 1, state: 1, identity: 1, constraint: 1 },
    general: {}
  };
  return boosts[intent][role] ?? 0;
}

function semanticIntentBoost(item: MemoryV2RecallItem, intent: MemoryV2SearchIntent): number {
  if (intent !== "identity") return 0;
  const text = `${item.statement} ${(item.path ?? "")}`.toLowerCase();
  const nameLikeMemory = /preferred[-_\s]?name|nickname|call me|called|my name|user name|名字|称呼|叫我|叫作|叫做/.test(text);
  if (!nameLikeMemory) return 0;
  // 与旧 kind 判定等价：kind∈{preference,fact} ⟺ role∉{decision,lesson,state}
  // （identity/constraint 的 kind 曾被压缩成 fact）
  return item.semanticRole === "decision" || item.semanticRole === "lesson" || item.semanticRole === "state" ? 2 : 5;
}

function recentDailyFiles(dir: string, maxDays: number): string[] {
  return recentFiles(dir, maxDays, /^\d{4}-\d{2}-\d{2}\.md$/);
}

function recentRunFiles(dir: string | undefined, maxFiles: number): string[] {
  if (!dir) return [];
  return recentFiles(dir, maxFiles, /^run_.+\.jsonl$/);
}

function recentFiles(dir: string, maxFiles: number, pattern: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => pattern.test(name))
    .map((name) => join(dir, name))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    })
    .sort()
    .reverse()
    .slice(0, maxFiles);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}/._-]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

async function maybeSemanticRecall(input: {
  input: MemoryV2SearchInput;
  query: string;
  candidates: MemoryV2RecallItem[];
  semantic: "auto" | "off";
  maxResults: number;
  hasBaseRecall: boolean;
}): Promise<MemoryV2RecallItem[]> {
  if (input.semantic === "off") return [];
  const hasExplicitEmbedding = Boolean(input.input.embedTexts || input.input.embeddingAttempts);
  const configuredModelRef = resolveMemoryEmbeddingModelRef(getEffectiveLumeConfig(input.input.workspaceSlug));
  if (!hasExplicitEmbedding
    && input.hasBaseRecall
    && configuredModelRef === LOCAL_ONNX_MEMORY_EMBEDDING_MODEL_REF
    && !isLocalOnnxReadyForInlineSemantic()
  ) {
    return [];
  }
  if (!hasExplicitEmbedding && !configuredModelRef && input.hasBaseRecall) return [];
  const attempts = input.input.embeddingAttempts ?? (
    input.input.embedTexts
      ? [{ modelKey: "test-embedding", embedTexts: input.input.embedTexts }]
      : createMemoryV2EmbeddingAttempts(input.input.workspaceSlug)
  );
  for (const attempt of attempts) {
    try {
      return await searchSemanticRecall({
        workspaceSlug: input.input.workspaceSlug,
        query: input.query,
        candidates: input.candidates,
        embedTexts: attempt.embedTexts,
        modelKey: attempt.modelKey,
        maxResults: input.maxResults
      });
    } catch {
      continue;
    }
  }
  return [];
}

function isLocalOnnxReadyForInlineSemantic(): boolean {
  const status = getLocalOnnxMemoryEmbeddingStatus().status;
  return status === "ready" || status === "cached";
}

function mergeRecallItems(items: MemoryV2RecallItem[]): MemoryV2RecallItem[] {
  const byId = new Map<string, MemoryV2RecallItem>();
  for (const item of items) {
    const existing = byId.get(item.id);
    if (!existing || item.score > existing.score) byId.set(item.id, item);
  }
  return [...byId.values()];
}
