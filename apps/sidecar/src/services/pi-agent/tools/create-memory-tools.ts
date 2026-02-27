import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { MemorySearchResult } from "@lume/shared";
import {
  getWorkspaceMemoryFile,
  saveWorkspaceMemory,
  searchWorkspaceMemory
} from "../../memory-service";
import {
  MEMORY_GET_TOOL_NAME,
  MEMORY_SAVE_TOOL_NAME,
  MEMORY_SEARCH_TOOL_NAME
} from "../../memory-mcp-service";

function formatCitation(path: string, startLine: number, endLine: number): string {
  return startLine === endLine ? `${path}#L${startLine}` : `${path}#L${startLine}-L${endLine}`;
}

function toTextResult<TDetails>(details: TDetails): AgentToolResult<TDetails> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(details, null, 2)
      }
    ],
    details
  };
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

export function createPiMemoryTools(params: {
  workspaceSlug: string;
  enabledTools: Set<string>;
  includeCitations: boolean;
}): AgentTool[] {
  const tools: AgentTool[] = [];

  if (params.enabledTools.has(MEMORY_SEARCH_TOOL_NAME)) {
    tools.push({
      name: MEMORY_SEARCH_TOOL_NAME,
      label: MEMORY_SEARCH_TOOL_NAME,
      description:
        "Mandatory recall step: search MEMORY.md/memory.md + memory/*.md before answering questions about prior work, decisions, dates, preferences, or todos.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1 }),
        maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
        minScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1 }))
      }),
      async execute(_toolCallId, args) {
        const input = args as Record<string, unknown>;
        const results = await searchWorkspaceMemory({
          workspaceSlug: params.workspaceSlug,
          query: String(input.query ?? ""),
          maxResults: typeof input.maxResults === "number" ? input.maxResults : undefined,
          minScore: typeof input.minScore === "number" ? input.minScore : undefined
        });
        return toTextResult({
          results: decorateSearchResults(results, params.includeCitations)
        });
      }
    });
  }

  if (params.enabledTools.has(MEMORY_GET_TOOL_NAME)) {
    tools.push({
      name: MEMORY_GET_TOOL_NAME,
      label: MEMORY_GET_TOOL_NAME,
      description:
        "Read a bounded snippet from MEMORY.md/memory.md or memory/*.md. Use after memory_search.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1 }),
        from: Type.Optional(Type.Number({ minimum: 1 })),
        lines: Type.Optional(Type.Number({ minimum: 1, maximum: 2000 }))
      }),
      async execute(_toolCallId, args) {
        const input = args as Record<string, unknown>;
        const result = getWorkspaceMemoryFile({
          workspaceSlug: params.workspaceSlug,
          path: String(input.path ?? ""),
          from: typeof input.from === "number" ? input.from : undefined,
          lines: typeof input.lines === "number" ? input.lines : undefined
        });
        return toTextResult(result);
      }
    });
  }

  if (params.enabledTools.has(MEMORY_SAVE_TOOL_NAME)) {
    tools.push({
      name: MEMORY_SAVE_TOOL_NAME,
      label: MEMORY_SAVE_TOOL_NAME,
      description: "将新记忆写入 memory/YYYY-MM-DD.md（短期）或 MEMORY.md（长期，需指定 path='MEMORY.md'）并立即索引。",
      parameters: Type.Object({
        content: Type.String({ minLength: 1 }),
        path: Type.Optional(Type.String({ description: "写入路径，如 'MEMORY.md' 表示长期记忆；省略则写入今日短期记忆" })),
        date: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }))
      }),
      async execute(_toolCallId, args) {
        const input = args as Record<string, unknown>;
        const result = await saveWorkspaceMemory({
          workspaceSlug: params.workspaceSlug,
          content: String(input.content ?? ""),
          path: typeof input.path === "string" ? input.path : undefined,
          date: typeof input.date === "string" ? input.date : undefined
        });
        return toTextResult(result);
      }
    });
  }

  return tools;
}
