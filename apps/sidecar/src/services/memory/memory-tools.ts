import { existsSync, readFileSync } from "node:fs";
import type {
  GlobalMemoryCandidate,
  MemoryIndexDocumentToolInput,
  MemoryDistillationResult,
  MemoryDistillWorkspaceToolInput,
  MemoryFlushToolInput,
  MemoryItem,
  MemoryListGlobalCandidatesToolInput,
  MemoryProviderStatus,
  MemoryReadToolInput,
  MemoryReadToolResult,
  MemoryRejectGlobalCandidateToolInput,
  MemoryRememberToolInput,
  MemorySaveInput,
  MemorySearchResult,
  MemorySearchGlobalToolInput,
  MemorySearchToolInput,
  MemoryToolName,
  MemoryToolWriteResult,
  MemoryWriteEpisodeInput,
  MemoryWriteEpisodeResult,
  PromoteGlobalMemoryInput
} from "@lume/shared";
import { runStructuredMemoryFlush } from "./memory-flush-runner";
import {
  getLayeredMemoryStatus,
  indexWorkspaceMemoryDocument,
  indexWorkspaceMemoryCorpus,
  runWorkspaceMemoryDistillation,
  writeWorkspaceMemory
} from "./memory-service";
import {
  listGlobalMemoryCandidates,
  promoteGlobalMemory,
  rejectGlobalMemoryCandidate,
  searchGlobalMemory
} from "./memory-global-promoter";
import { searchMemoryV2 } from "../memory-v2/retrieval";
import { createMemoryV2Store } from "../memory-v2/markdown-store";
import { smartAddMemoryV2Candidate } from "../memory-v2/smart-add";
import type { MemoryV2Kind, MemoryV2Scope } from "../memory-v2/types";

export const MVP_MEMORY_TOOL_NAMES = [
  "memory.search",
  "memory.read",
  "memory.remember",
  "memory.writeEpisode",
  "memory.flush",
  "memory.distillWorkspace",
  "memory.status",
  "memory.indexWorkspace"
] as const satisfies readonly MemoryToolName[];

export const GLOBAL_MEMORY_TOOL_NAMES = [
  "memory.searchGlobal",
  "memory.listGlobalCandidates",
  "memory.promoteGlobal",
  "memory.rejectGlobalCandidate"
] as const satisfies readonly MemoryToolName[];

export const MEMORY_TOOL_NAMES = [
  ...MVP_MEMORY_TOOL_NAMES,
  ...GLOBAL_MEMORY_TOOL_NAMES,
  "memory.indexDocument"
] as const satisfies readonly MemoryToolName[];

type MemoryToolsDeps = {
  searchGlobalMemory?: typeof searchGlobalMemory;
  listGlobalMemoryCandidates?: typeof listGlobalMemoryCandidates;
  promoteGlobalMemory?: typeof promoteGlobalMemory;
  rejectGlobalMemoryCandidate?: typeof rejectGlobalMemoryCandidate;
  writeWorkspaceMemory?: typeof writeWorkspaceMemory;
  runStructuredMemoryFlush?: typeof runStructuredMemoryFlush;
  runWorkspaceMemoryDistillation?: typeof runWorkspaceMemoryDistillation;
  getLayeredMemoryStatus?: typeof getLayeredMemoryStatus;
  indexWorkspaceMemoryCorpus?: typeof indexWorkspaceMemoryCorpus;
  indexWorkspaceMemoryDocument?: typeof indexWorkspaceMemoryDocument;
};

export type MemoryTools = {
  "memory.search": (input: MemorySearchToolInput) => Promise<MemorySearchResult[]>;
  "memory.read": (input: MemoryReadToolInput) => Promise<MemoryReadToolResult>;
  "memory.remember": (input: MemoryRememberToolInput) => Promise<MemoryToolWriteResult>;
  "memory.writeEpisode": (input: MemoryWriteEpisodeInput) => Promise<MemoryWriteEpisodeResult>;
  "memory.flush": (input: MemoryFlushToolInput) => Promise<Awaited<ReturnType<typeof runStructuredMemoryFlush>>>;
  "memory.distillWorkspace": (input: MemoryDistillWorkspaceToolInput) => Promise<MemoryDistillationResult>;
  "memory.status": (input: { workspaceSlug: string }) => Promise<MemoryProviderStatus>;
  "memory.indexWorkspace": (input: { workspaceSlug: string; force?: boolean }) => Promise<{ indexedChunks: number }>;
  "memory.searchGlobal": (input: MemorySearchGlobalToolInput) => Promise<MemorySearchResult[]>;
  "memory.listGlobalCandidates": (input?: MemoryListGlobalCandidatesToolInput) => Promise<GlobalMemoryCandidate[]>;
  "memory.promoteGlobal": (input: PromoteGlobalMemoryInput) => Promise<MemoryItem>;
  "memory.rejectGlobalCandidate": (input: MemoryRejectGlobalCandidateToolInput) => Promise<GlobalMemoryCandidate>;
  "memory.indexDocument": (input: MemoryIndexDocumentToolInput) => Promise<{ indexedChunks: number }>;
};

function defaultIncludeGlobal(input: MemorySearchToolInput): boolean {
  if (typeof input.includeGlobal === "boolean") return input.includeGlobal;
  return input.sessionType === undefined || input.sessionType === "main";
}

function formatEpisodeContent(input: MemoryWriteEpisodeInput): string {
  const lines = [`# ${input.title}`, "", input.summary.trim()];
  const addList = (heading: string, values?: string[]) => {
    const items = (values ?? []).map((item) => item.trim()).filter(Boolean);
    if (items.length === 0) return;
    lines.push("", `## ${heading}`, ...items.map((item) => `- ${item}`));
  };
  addList("Outcomes", input.outcomes);
  addList("Decisions", input.decisions);
  addList("Preferences", input.preferences);
  addList("Lessons", input.lessons);
  addList("Next Steps", input.nextSteps);
  return lines.join("\n").trim();
}

export function createMemoryTools(deps: MemoryToolsDeps = {}): MemoryTools {
  const resolved = {
    searchGlobalMemory,
    listGlobalMemoryCandidates,
    promoteGlobalMemory,
    rejectGlobalMemoryCandidate,
    writeWorkspaceMemory,
    runStructuredMemoryFlush,
    runWorkspaceMemoryDistillation,
    getLayeredMemoryStatus,
    indexWorkspaceMemoryCorpus,
    indexWorkspaceMemoryDocument,
    ...deps
  };

  return {
    async "memory.search"(input) {
      const v2Results = await searchMemoryV2({
        workspaceSlug: input.workspaceSlug,
        query: input.query,
        maxResults: input.maxResults,
        scopes: resolveMemoryV2SearchScopes(input)
      });
      return v2Results.map((item) => ({
        id: item.id,
        path: item.path,
        snippet: item.statement,
        citation: item.citation,
        score: item.score,
        kind: fromMemoryV2Kind(item.kind),
        scope: item.scope,
        source: "memory",
        reason: item.reason
      }));
    },

    async "memory.read"(input) {
      if (input.id) {
        const entry = createMemoryV2Store().listEntries({
          workspaceSlug: input.workspaceSlug,
          includeStatuses: ["active", "suspected_stale", "archived", "superseded"]
        }).find((item) => item.frontmatter.id === input.id);
        if (!entry) throw new Error("记忆不存在");
        return {
          id: entry.frontmatter.id,
          path: entry.path,
          text: entry.statement,
          metadata: {
            id: entry.frontmatter.id,
            workspaceSlug: input.workspaceSlug,
            scope: entry.frontmatter.scope,
            kind: fromMemoryV2Kind(entry.frontmatter.kind),
            source: "memory",
            tags: entry.frontmatter.tags,
            confidence: confidenceNumber(entry.frontmatter.confidence)
          },
          citation: entry.path
        };
      }
      if (!input.path) {
        throw new Error("memory.read requires id or path");
      }
      if (!existsSync(input.path)) {
        throw new Error("记忆文件不存在");
      }
      const text = input.path.endsWith(".md")
        ? readMemoryFileText(input.path, input.from, input.lines)
        : readFileSync(input.path, "utf-8");
      return {
        path: input.path,
        text,
        citation: input.from ? `${input.path}#L${input.from}` : input.path
      };
    },

    async "memory.remember"(input) {
      const scope = toMemoryV2Scope(input.scope);
      const kind = toMemoryV2Kind(input.kind);
      const result = smartAddMemoryV2Candidate({
        workspaceSlug: input.workspaceSlug,
        candidate: {
          targetScope: scope,
          kind,
          statement: input.content,
          confidence: toMemoryV2Confidence(input.confidence),
          tags: input.tags,
          appliesWhen: scope === "workspace" ? { workspaceSlug: input.workspaceSlug } : {},
          evidence: {
            runId: input.sourceSessionId,
            recordIds: input.sourceMessageIds
          }
        }
      });
      if (result.entry) {
        return {
          id: result.entry.frontmatter.id,
          path: result.entry.path,
          kind: input.kind,
          scope: input.scope
        };
      }
      if (result.pending) {
        return {
          id: result.pending.frontmatter.id,
          path: result.pending.path,
          kind: input.kind,
          scope: input.scope
        };
      }
      return {
        kind: input.kind,
        scope: input.scope
      };
    },

    async "memory.writeEpisode"(input) {
      const writes: MemorySaveInput[] = [{
        workspaceSlug: input.workspaceSlug,
        content: formatEpisodeContent(input),
        scope: "session",
        kind: "episode",
        source: "manual",
        title: input.title,
        summary: input.summary,
        importance: 3,
        confidence: 1,
        sourceSessionId: input.sessionId,
        sourceMessageIds: input.sourceMessageIds
      }];
      for (const content of input.decisions ?? []) {
        writes.push({
          workspaceSlug: input.workspaceSlug,
          content,
          scope: "workspace",
          kind: "decision",
          source: "manual",
          importance: 4,
          confidence: 1,
          sourceSessionId: input.sessionId,
          sourceMessageIds: input.sourceMessageIds
        });
      }
      for (const content of input.preferences ?? []) {
        writes.push({
          workspaceSlug: input.workspaceSlug,
          content,
          scope: "workspace",
          kind: "preference",
          source: "manual",
          importance: 4,
          confidence: 1,
          sourceSessionId: input.sessionId,
          sourceMessageIds: input.sourceMessageIds
        });
      }
      for (const content of input.lessons ?? []) {
        writes.push({
          workspaceSlug: input.workspaceSlug,
          content,
          scope: "workspace",
          kind: "lesson",
          source: "manual",
          importance: 3,
          confidence: 1,
          sourceSessionId: input.sessionId,
          sourceMessageIds: input.sourceMessageIds
        });
      }

      const itemIds: string[] = [];
      let savedCount = 0;
      let skippedCount = 0;
      for (const write of writes) {
        try {
          const result = await resolved.writeWorkspaceMemory(write);
          if (result.itemId) itemIds.push(result.itemId);
          savedCount += 1;
        } catch {
          skippedCount += 1;
        }
      }
      return { savedCount, skippedCount, itemIds };
    },

    async "memory.flush"(input) {
      return resolved.runStructuredMemoryFlush({
        workspaceSlug: input.workspaceSlug,
        sessionId: input.sessionId,
        rawOutput: JSON.stringify({ entries: input.entries })
      });
    },

    async "memory.distillWorkspace"(input) {
      return resolved.runWorkspaceMemoryDistillation(input);
    },

    async "memory.status"(input) {
      return resolved.getLayeredMemoryStatus(input.workspaceSlug);
    },

    async "memory.indexWorkspace"(input) {
      return resolved.indexWorkspaceMemoryCorpus(input);
    },

    async "memory.searchGlobal"(input) {
      return resolved.searchGlobalMemory(input);
    },

    async "memory.listGlobalCandidates"(input = {}) {
      return resolved.listGlobalMemoryCandidates(input);
    },

    async "memory.promoteGlobal"(input) {
      return resolved.promoteGlobalMemory(input);
    },

    async "memory.rejectGlobalCandidate"(input) {
      return resolved.rejectGlobalMemoryCandidate(input.candidateId);
    },

    async "memory.indexDocument"(input) {
      return resolved.indexWorkspaceMemoryDocument(input);
    }
  };
}

function resolveMemoryV2SearchScopes(input: MemorySearchToolInput): MemoryV2Scope[] {
  const scopes = input.scopes
    ?.map(toMemoryV2Scope)
    .filter((scope, index, all): scope is MemoryV2Scope => Boolean(scope) && all.indexOf(scope) === index);
  if (scopes && scopes.length > 0) return scopes;
  const includeWorkspace = input.includeWorkspace !== false;
  const includeGlobal = defaultIncludeGlobal(input);
  return [
    ...(includeGlobal ? ["global" as const] : []),
    ...(includeWorkspace ? ["workspace" as const] : [])
  ];
}

function toMemoryV2Scope(scope?: string): MemoryV2Scope {
  return scope === "global" ? "global" : "workspace";
}

function toMemoryV2Kind(kind?: string): MemoryV2Kind {
  if (
    kind === "preference"
    || kind === "fact"
    || kind === "decision"
    || kind === "lesson"
  ) {
    return kind;
  }
  if (kind === "episode" || kind === "summary" || kind === "milestone") return "state";
  return "fact";
}

function fromMemoryV2Kind(kind: MemoryV2Kind): MemorySearchResult["kind"] {
  return kind === "state" ? "summary" : kind;
}

function confidenceNumber(confidence: "low" | "medium" | "high"): number {
  if (confidence === "high") return 1;
  if (confidence === "medium") return 0.65;
  return 0.3;
}

function readMemoryFileText(path: string, from?: number, lines?: number): string {
  const content = readFileSync(path, "utf-8");
  if (!from && !lines) return content;
  const allLines = content.split("\n");
  const start = Math.max((from ?? 1) - 1, 0);
  const end = lines ? start + Math.max(lines, 0) : allLines.length;
  return allLines.slice(start, end).join("\n");
}

function toMemoryV2Confidence(confidence?: number): "low" | "medium" | "high" {
  if (typeof confidence !== "number") return "medium";
  if (confidence >= 0.75) return "high";
  if (confidence < 0.45) return "low";
  return "medium";
}
