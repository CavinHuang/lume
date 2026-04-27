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
  MemorySaveResult,
  MemorySearchResult,
  MemorySearchGlobalToolInput,
  MemorySearchToolInput,
  MemoryStats,
  MemoryToolName,
  MemoryToolWriteResult,
  MemoryWriteEpisodeInput,
  MemoryWriteEpisodeResult,
  PromoteGlobalMemoryInput
} from "@lume/shared";
import {
  getGlobalStructuredMemoryDbPath,
  getWorkspaceMemoryDbPath
} from "../infra/config-paths";
import { MemoryRepository } from "./memory-repository";
import { runStructuredMemoryFlush } from "./memory-flush-runner";
import {
  getLayeredMemoryStatus,
  indexWorkspaceMemoryDocument,
  indexWorkspaceMemoryCorpus,
  readLayeredMemoryFile,
  runWorkspaceMemoryDistillation,
  searchLayeredMemory,
  writeWorkspaceMemory
} from "./memory-service";
import {
  listGlobalMemoryCandidates,
  promoteGlobalMemory,
  rejectGlobalMemoryCandidate,
  searchGlobalMemory
} from "./memory-global-promoter";

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
  searchLayeredMemory?: typeof searchLayeredMemory;
  searchGlobalMemory?: typeof searchGlobalMemory;
  listGlobalMemoryCandidates?: typeof listGlobalMemoryCandidates;
  promoteGlobalMemory?: typeof promoteGlobalMemory;
  rejectGlobalMemoryCandidate?: typeof rejectGlobalMemoryCandidate;
  readLayeredMemoryFile?: typeof readLayeredMemoryFile;
  writeWorkspaceMemory?: typeof writeWorkspaceMemory;
  runStructuredMemoryFlush?: typeof runStructuredMemoryFlush;
  runWorkspaceMemoryDistillation?: typeof runWorkspaceMemoryDistillation;
  getLayeredMemoryStatus?: typeof getLayeredMemoryStatus;
  indexWorkspaceMemoryCorpus?: typeof indexWorkspaceMemoryCorpus;
  indexWorkspaceMemoryDocument?: typeof indexWorkspaceMemoryDocument;
  createRepository?: (workspaceSlug: string) => MemoryRepository;
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

function isPrivateSessionType(input: MemorySearchToolInput): boolean {
  return input.sessionType === "subagent" || input.sessionType === "group" || input.sessionType === "channel";
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

function resultToWriteResult(input: {
  result: MemorySaveResult;
  kind: MemorySaveInput["kind"];
  scope: MemorySaveInput["scope"];
}): MemoryToolWriteResult {
  return {
    id: input.result.itemId,
    path: input.result.path,
    kind: input.kind,
    scope: input.scope
  };
}

function memoryItemToReadResult(item: Awaited<ReturnType<MemoryRepository["get"]>>): MemoryReadToolResult {
  if (!item) {
    throw new Error("记忆不存在");
  }
  return {
    id: item.id,
    path: item.sourcePath,
    text: item.content,
    metadata: {
      id: item.id,
      workspaceSlug: item.workspaceSlug,
      scope: item.scope,
      kind: item.kind,
      source: item.source,
      title: item.title,
      summary: item.summary,
      tags: item.tags,
      importance: item.importance,
      confidence: item.confidence,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    },
    citation: item.sourcePath
  };
}

async function readMemoryById(input: {
  workspaceSlug: string;
  id: string;
  deps: Required<Pick<MemoryToolsDeps, "createRepository">>;
}): Promise<MemoryReadToolResult> {
  const repository = input.deps.createRepository(input.workspaceSlug);
  try {
    return memoryItemToReadResult(await repository.get(input.id));
  } finally {
    repository.dispose();
  }
}

export function createMemoryTools(deps: MemoryToolsDeps = {}): MemoryTools {
  const resolved = {
    searchLayeredMemory,
    searchGlobalMemory,
    listGlobalMemoryCandidates,
    promoteGlobalMemory,
    rejectGlobalMemoryCandidate,
    readLayeredMemoryFile,
    writeWorkspaceMemory,
    runStructuredMemoryFlush,
    runWorkspaceMemoryDistillation,
    getLayeredMemoryStatus,
    indexWorkspaceMemoryCorpus,
    indexWorkspaceMemoryDocument,
    createRepository: (workspaceSlug: string) => new MemoryRepository({
      dbPath: workspaceSlug === "__global__"
        ? getGlobalStructuredMemoryDbPath()
        : getWorkspaceMemoryDbPath(workspaceSlug),
      workspaceSlug
    }),
    ...deps
  };

  return {
    async "memory.search"(input) {
      const includeWorkspace = input.includeWorkspace !== false;
      const includeGlobal = defaultIncludeGlobal(input);
      const constrainedInput = {
        ...input,
        includeGlobal,
        includeLongTerm: isPrivateSessionType(input) ? false : input.includeLongTerm,
        includeSessions: isPrivateSessionType(input) ? false : input.includeSessions
      };
      if (!includeWorkspace && includeGlobal) {
        return resolved.searchGlobalMemory({
          query: input.query,
          maxResults: input.maxResults
        });
      }
      return resolved.searchLayeredMemory(constrainedInput);
    },

    async "memory.read"(input) {
      if (input.id) {
        return readMemoryById({
          workspaceSlug: input.workspaceSlug,
          id: input.id,
          deps: { createRepository: resolved.createRepository }
        });
      }
      if (!input.path) {
        throw new Error("memory.read requires id or path");
      }
      const result = resolved.readLayeredMemoryFile({
        workspaceSlug: input.workspaceSlug,
        path: input.path,
        from: input.from,
        lines: input.lines
      });
      return {
        path: result.path,
        text: result.text,
        citation: `${result.path}#L${result.from}`
      };
    },

    async "memory.remember"(input) {
      const result = await resolved.writeWorkspaceMemory({
        workspaceSlug: input.workspaceSlug,
        content: input.content,
        scope: input.scope,
        kind: input.kind,
        source: "manual",
        title: input.title,
        importance: input.importance,
        confidence: input.confidence,
        tags: input.tags,
        sourceSessionId: input.sourceSessionId,
        sourceMessageIds: input.sourceMessageIds,
        requireReview: input.requireReview
      });
      return resultToWriteResult({ result, kind: input.kind, scope: input.scope });
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
