import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getMemoryV2ScopePaths } from "./paths";
import { createMemoryV2Store, type MemoryV2Store } from "./markdown-store";
import type {
  MemoryV2Entry,
  MemoryV2Kind,
  MemoryV2RecallItem,
  MemoryV2Scope
} from "./types";

export interface MemoryV2SearchInput {
  workspaceSlug?: string;
  query: string;
  maxResults?: number;
  scopes?: MemoryV2Scope[];
  intent?: MemoryV2SearchIntent;
  includeRecentDaily?: boolean;
  store?: MemoryV2Store;
}

export type MemoryV2SearchIntent =
  | "architecture"
  | "continue_task"
  | "identity"
  | "preference"
  | "debug"
  | "commit"
  | "general";

export async function searchMemoryV2(input: MemoryV2SearchInput): Promise<MemoryV2RecallItem[]> {
  const store = input.store ?? createMemoryV2Store();
  const query = input.query.trim();
  if (!query) return [];
  const intent = input.intent ?? inferSearchIntent(query);
  const scopes = input.scopes ?? (input.workspaceSlug ? ["global", "workspace"] : ["global"]);
  const candidates = [
    ...entryRecallCandidates(store.listEntries({
      workspaceSlug: input.workspaceSlug,
      scopes,
      includeStatuses: ["active", "suspected_stale"]
    })),
    ...markdownRecallCandidates({
      workspaceSlug: input.workspaceSlug,
      scopes,
      includeRecentDaily: input.includeRecentDaily ?? true
    })
  ];
  const scored = candidates
    .map((item) => ({
      item,
      score: scoreRecallItem(item, query, intent)
    }))
    .filter(({ item, score }) => {
      if (item.status === "suspected_stale") return score >= 7;
      return score > 0;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, input.maxResults ?? 8)
    .map(({ item, score }) => ({ ...item, score }));
  return scored;
}

export function inferSearchIntent(query: string): MemoryV2SearchIntent {
  const text = query.toLowerCase();
  if (/architecture|design|boundary|架构|设计|边界/.test(text)) return "architecture";
  if (/continue|next|todo|state|继续|下一步|进度|状态/.test(text)) return "continue_task";
  if (/who am i|what'?s my name|what is my name|call me|my name|我是谁|我叫什么|我的名字|叫我什么|怎么称呼|称呼我|名字/.test(text)) return "identity";
  if (/prefer|preference|rule|habit|偏好|习惯|规则/.test(text)) return "preference";
  if (/debug|error|fail|bug|报错|失败|修复/.test(text)) return "debug";
  if (/commit|push|pr|提交|推送/.test(text)) return "commit";
  return "general";
}

function entryRecallCandidates(entries: MemoryV2Entry[]): MemoryV2RecallItem[] {
  return entries.map((entry) => ({
    id: entry.frontmatter.id,
    kind: entry.frontmatter.kind,
    scope: entry.frontmatter.scope,
    status: entry.frontmatter.status === "suspected_stale" ? "suspected_stale" : "active",
    statement: entry.statement,
    path: entry.path,
    citation: entry.path,
    reason: entry.frontmatter.pinned ? "pinned memory" : "matched memory entry",
    score: 0,
    pinned: entry.frontmatter.pinned
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
      for (const path of recentDailyFiles(paths.dailyDir, 7)) {
        const text = readFileSync(path, "utf-8").trim();
        if (!text) continue;
        items.push({
          id: `${scope}:daily:${path}`,
          kind: "state",
          scope,
          status: "active",
          statement: text,
          path,
          citation: path,
          reason: "recent daily memory",
          score: 0
        });
      }
    }
  }
  return items;
}

function scoreRecallItem(item: MemoryV2RecallItem, query: string, intent: MemoryV2SearchIntent): number {
  const queryTokens = new Set(tokenize(query));
  const itemTokens = tokenize(`${item.statement} ${item.path}`);
  const lexical = itemTokens.reduce((score, token) => score + (queryTokens.has(token) ? 1 : 0), 0);
  const semanticScore = semanticIntentBoost(item, intent);
  if (lexical === 0 && semanticScore === 0 && !item.pinned) return 0;
  const pathScore = [...queryTokens].some((token) => item.path.toLowerCase().includes(token)) ? 1.5 : 0;
  const pinnedScore = item.pinned ? 2 : 0;
  const scopeScore = item.scope === "workspace" ? 1 : 0.5;
  const kindScore = kindIntentBoost(item.kind, intent);
  const stalePenalty = item.status === "suspected_stale" ? -3 : 0;
  return lexical + semanticScore + pathScore + pinnedScore + scopeScore + kindScore + stalePenalty;
}

function kindIntentBoost(kind: MemoryV2Kind, intent: MemoryV2SearchIntent): number {
  const boosts: Record<MemoryV2SearchIntent, Partial<Record<MemoryV2Kind, number>>> = {
    architecture: { decision: 3, fact: 2, lesson: 2 },
    continue_task: { state: 3, decision: 1 },
    identity: { preference: 3, fact: 2 },
    preference: { preference: 3 },
    debug: { lesson: 3, fact: 1 },
    commit: { preference: 2, fact: 1, state: 1 },
    general: {}
  };
  return boosts[intent][kind] ?? 0;
}

function semanticIntentBoost(item: MemoryV2RecallItem, intent: MemoryV2SearchIntent): number {
  if (intent !== "identity") return 0;
  const text = `${item.statement} ${(item.path ?? "")}`.toLowerCase();
  const nameLikeMemory = /preferred[-_\s]?name|nickname|call me|called|my name|user name|名字|称呼|叫我|叫作|叫做/.test(text);
  if (!nameLikeMemory) return 0;
  return item.kind === "preference" || item.kind === "fact" ? 5 : 2;
}

function recentDailyFiles(dir: string, maxDays: number): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
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
    .slice(0, maxDays);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}/._-]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}
