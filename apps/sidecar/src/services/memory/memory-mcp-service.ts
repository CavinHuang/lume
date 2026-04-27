import { z } from "zod";
import type { MemorySearchResult } from "@lume/shared";
import type { MemoryCitationsMode } from "./memory-policy";
import {
  getLayeredMemoryStatus,
  readLayeredMemoryFile,
  searchLayeredMemory,
  writeWorkspaceMemory
} from "./memory-service";
import { createMemoryToolErrorResult, createMemoryToolResult } from "./memory-tool-response";

export const MEMORY_SEARCH_TOOL_NAME = "memory_search";
export const MEMORY_GET_TOOL_NAME = "memory_get";
export const MEMORY_SAVE_TOOL_NAME = "memory_save";

type McpServerConfig = Record<string, unknown>;
type SdkMcpFactory = {
  createSdkMcpServer: (config: Record<string, unknown>) => McpServerConfig;
};

function formatCitation(path: string, startLine: number, endLine: number): string {
  return startLine === endLine ? `${path}#L${startLine}` : `${path}#L${startLine}-L${endLine}`;
}

function decorateMemorySearchResults(params: {
  includeCitations: boolean;
  results: MemorySearchResult[];
}): MemorySearchResult[] {
  if (!params.includeCitations) {
    return params.results.map((entry) => ({ ...entry, citation: undefined }));
  }
  return params.results.map((entry) => {
    const citation = entry.citation ?? formatCitation(entry.path, entry.startLine ?? 1, entry.endLine ?? 1);
    const hasSourceLine = /\n\nSource:\s+/i.test(entry.snippet);
    const snippet = hasSourceLine ? entry.snippet : `${entry.snippet.trim()}\n\nSource: ${citation}`;
    return { ...entry, citation, snippet };
  });
}

export function buildMemoryMcpServer(
  workspaceSlug: string,
  sdk: SdkMcpFactory,
  options: {
    enabledTools: Set<string>;
    includeCitations: boolean;
    citationsMode: MemoryCitationsMode;
    deps?: {
      searchLayeredMemory?: typeof searchLayeredMemory;
      readLayeredMemoryFile?: typeof readLayeredMemoryFile;
      writeWorkspaceMemory?: typeof writeWorkspaceMemory;
      getLayeredMemoryStatus?: typeof getLayeredMemoryStatus;
    };
  }
): McpServerConfig {
  const deps = {
    searchLayeredMemory,
    readLayeredMemoryFile,
    writeWorkspaceMemory,
    getLayeredMemoryStatus,
    ...(options.deps ?? {})
  };

  const memorySearchSchema = z.object({
    query: z.string().min(1),
    maxResults: z.number().int().min(1).max(20).optional(),
    minScore: z.number().min(0).max(1).optional()
  });
  const memoryGetSchema = z.object({
    path: z.string().min(1),
    from: z.number().int().min(1).optional(),
    lines: z.number().int().min(1).max(2000).optional()
  });
  const memorySaveSchema = z.object({
    content: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
  });

  return sdk.createSdkMcpServer({
    name: "lume-memory",
    tools: [
      ...(options.enabledTools.has(MEMORY_SEARCH_TOOL_NAME)
        ? [{
        name: MEMORY_SEARCH_TOOL_NAME,
        description:
          "Mandatory recall step: semantically search thread note + workspace memory/YYYY-MM-DD.md + workspace MEMORY.md + global ~/.lume/MEMORY.md before answering questions about prior work, decisions, dates, people, preferences, or todos; returns top snippets with path + lines.",
        inputSchema: memorySearchSchema.shape,
        handler: async (rawArgs: unknown) => {
          try {
            const { query, maxResults, minScore } = memorySearchSchema.parse(rawArgs);
            const [results, status] = await Promise.all([
              deps.searchLayeredMemory({ workspaceSlug, query, maxResults, minScore }),
              Promise.resolve(deps.getLayeredMemoryStatus(workspaceSlug))
            ]);
            const decorated = decorateMemorySearchResults({
              includeCitations: options.includeCitations,
              results
            });
            const payload = {
              results: decorated,
              provider: status.provider,
              model: status.model,
              fallback: status.fallback,
              citations: options.citationsMode
            };
            return createMemoryToolResult(payload);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return createMemoryToolErrorResult({ results: [], disabled: true, error: message });
          }
        }
      }]
        : []),
      ...(options.enabledTools.has(MEMORY_GET_TOOL_NAME)
        ? [{
        name: MEMORY_GET_TOOL_NAME,
        description:
          "Safe snippet read from workspace MEMORY.md, workspace memory/YYYY-MM-DD.md, sessions/*, or global ~/.lume/MEMORY.md with optional from/lines; use after memory_search to pull only the needed lines and keep context small.",
        inputSchema: memoryGetSchema.shape,
        handler: async (rawArgs: unknown) => {
          try {
            const { path, from, lines } = memoryGetSchema.parse(rawArgs);
            const result = deps.readLayeredMemoryFile({ workspaceSlug, path, from, lines });
            return createMemoryToolResult(result);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const fallbackPath =
              rawArgs && typeof rawArgs === "object" && typeof (rawArgs as { path?: unknown }).path === "string"
                ? (rawArgs as { path: string }).path
                : "";
            return createMemoryToolErrorResult({
              path: fallbackPath,
              text: "",
              disabled: true,
              error: message
            });
          }
        }
      }]
        : []),
      ...(options.enabledTools.has(MEMORY_SAVE_TOOL_NAME)
        ? [{
        name: MEMORY_SAVE_TOOL_NAME,
        description: "将新记忆写入 memory/YYYY-MM-DD.md（短期）或 MEMORY.md（workspace 长期，需指定 path='MEMORY.md'）并立即索引。",
        inputSchema: memorySaveSchema.shape,
        handler: async (rawArgs: unknown) => {
          try {
            const { content, date } = memorySaveSchema.parse(rawArgs);
            const result = await deps.writeWorkspaceMemory({ workspaceSlug, content, date });
            return createMemoryToolResult(result);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return createMemoryToolErrorResult({ disabled: true, error: message });
          }
        }
      }]
        : [])
    ]
  });
}
