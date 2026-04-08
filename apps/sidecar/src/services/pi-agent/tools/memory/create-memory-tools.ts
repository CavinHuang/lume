import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@lume/agent-sdk";
import type { MemorySearchResult } from "@lume/shared";
import {
  getWorkspaceMemoryFile,
  saveWorkspaceMemory,
  searchWorkspaceMemory
} from "../../../memory/memory-service";
import {
  MEMORY_GET_TOOL_NAME,
  MEMORY_SAVE_TOOL_NAME,
  MEMORY_SEARCH_TOOL_NAME
} from "../../../memory/memory-mcp-service";
import { createSdkJsonResultTool } from "../sdk-tool-result";

function formatCitation(path: string, startLine: number, endLine: number): string {
  return startLine === endLine ? `${path}#L${startLine}` : `${path}#L${startLine}-L${endLine}`;
}

function decorateSearchResults(results: MemorySearchResult[], includeCitations: boolean): MemorySearchResult[] {
  if (!includeCitations) return results;
  return results.map((item) => {
    const citation = item.citation ?? formatCitation(item.path, item.startLine, item.endLine);
    if (item.snippet.includes("\n\nSource:")) {
      return { ...item, citation };
    }
    return { ...item, citation, snippet: `${item.snippet.trim()}\n\nSource: ${citation}` };
  });
}

export function createSdkMemoryTools(params: {
  workspaceSlug: string;
  enabledTools: Set<string>;
  includeCitations: boolean;
}): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  if (params.enabledTools.has(MEMORY_SEARCH_TOOL_NAME)) {
    tools.push(createSdkJsonResultTool({
      name: MEMORY_SEARCH_TOOL_NAME,
      description:
        "Mandatory recall step: search MEMORY.md/memory.md + memory/*.md before answering questions about prior work, decisions, dates, preferences, or todos.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          maxResults: { type: "number", minimum: 1, maximum: 20 },
          minScore: { type: "number", minimum: 0, maximum: 1 }
        },
        required: ["query"]
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      async call(input) {
        const results = await searchWorkspaceMemory({
          workspaceSlug: params.workspaceSlug,
          query: String(input.query ?? ""),
          maxResults: typeof input.maxResults === "number" ? input.maxResults : undefined,
          minScore: typeof input.minScore === "number" ? input.minScore : undefined
        });
        return {
          results: decorateSearchResults(results, params.includeCitations)
        };
      }
    }));
  }

  if (params.enabledTools.has(MEMORY_GET_TOOL_NAME)) {
    tools.push(createSdkJsonResultTool({
      name: MEMORY_GET_TOOL_NAME,
      description: "Read a bounded snippet from MEMORY.md/memory.md or memory/*.md. Use after memory_search.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          from: { type: "number", minimum: 1 },
          lines: { type: "number", minimum: 1, maximum: 2000 }
        },
        required: ["path"]
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      async call(input) {
        return getWorkspaceMemoryFile({
          workspaceSlug: params.workspaceSlug,
          path: String(input.path ?? ""),
          from: typeof input.from === "number" ? input.from : undefined,
          lines: typeof input.lines === "number" ? input.lines : undefined
        });
      }
    }));
  }

  if (params.enabledTools.has(MEMORY_SAVE_TOOL_NAME)) {
    tools.push(createSdkJsonResultTool({
      name: MEMORY_SAVE_TOOL_NAME,
      description: "将新记忆写入 memory/YYYY-MM-DD.md（短期）或 MEMORY.md（长期，需指定 path='MEMORY.md'）并立即索引。",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", minLength: 1 },
          path: { type: "string" },
          date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }
        },
        required: ["content"]
      },
      async call(input) {
        return saveWorkspaceMemory({
          workspaceSlug: params.workspaceSlug,
          content: String(input.content ?? ""),
          path: typeof input.path === "string" ? input.path : undefined,
          date: typeof input.date === "string" ? input.date : undefined
        });
      }
    }));
  }

  return tools;
}

