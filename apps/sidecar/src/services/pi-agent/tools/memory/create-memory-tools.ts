import type { ToolDefinition } from "@lume/agent-sdk";
import type { MemoryKind, MemoryScope, MemorySearchResult } from "@lume/shared";
import { createMemoryTools } from "../../../memory/memory-tools";
import { writeWorkspaceMemory } from "../../../memory/memory-service";
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
    const citation = item.citation ?? formatCitation(item.path, item.startLine ?? 1, item.endLine ?? 1);
    if (item.snippet.includes("\n\nSource:")) {
      return { ...item, citation };
    }
    return { ...item, citation, snippet: `${item.snippet.trim()}\n\nSource: ${citation}` };
  });
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function optionalImportance(value: unknown): 1 | 2 | 3 | 4 | 5 | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(5, Math.max(1, Math.round(value))) as 1 | 2 | 3 | 4 | 5;
}

export function createSdkMemoryTools(params: {
  workspaceSlug: string;
  enabledTools: Set<string>;
  includeCitations: boolean;
}): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const memoryTools = createMemoryTools();

  if (params.enabledTools.has(MEMORY_SEARCH_TOOL_NAME)) {
    tools.push(createSdkJsonResultTool({
      name: MEMORY_SEARCH_TOOL_NAME,
      description:
        "Mandatory recall step: search thread note + workspace memory/YYYY-MM-DD.md + workspace MEMORY.md + global ~/.lume/MEMORY.md before answering questions about prior work, decisions, dates, preferences, or todos.",
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
        const results = await memoryTools["memory.search"]({
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

  if (params.enabledTools.has("memory.search")) {
    tools.push(createSdkJsonResultTool({
      name: "memory.search",
      description: "Search layered workspace memory and optional global memory. Use before tasks that depend on prior work, decisions, preferences, or todos.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          maxResults: { type: "number", minimum: 1, maximum: 20 },
          minScore: { type: "number", minimum: 0, maximum: 1 },
          includeGlobal: { type: "boolean" },
          includeWorkspace: { type: "boolean" },
          sessionType: { type: "string", enum: ["main", "subagent", "group", "channel"] }
        },
        required: ["query"]
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      async call(input) {
        const results = await memoryTools["memory.search"]({
          workspaceSlug: params.workspaceSlug,
          query: String(input.query ?? ""),
          maxResults: typeof input.maxResults === "number" ? input.maxResults : undefined,
          minScore: typeof input.minScore === "number" ? input.minScore : undefined,
          includeGlobal: typeof input.includeGlobal === "boolean" ? input.includeGlobal : undefined,
          includeWorkspace: typeof input.includeWorkspace === "boolean" ? input.includeWorkspace : undefined,
          sessionType: input.sessionType === "main" || input.sessionType === "subagent" || input.sessionType === "group" || input.sessionType === "channel"
            ? input.sessionType
            : undefined
        });
        return {
          results: decorateSearchResults(results, params.includeCitations)
        };
      }
    }));
  }

  if (params.enabledTools.has("memory.searchGlobal")) {
    tools.push(createSdkJsonResultTool({
      name: "memory.searchGlobal",
      description: "Search only approved global memory. Use for cross-workspace user preferences and long-term working style.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          maxResults: { type: "number", minimum: 1, maximum: 20 }
        },
        required: ["query"]
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      async call(input) {
        const results = await memoryTools["memory.searchGlobal"]({
          query: String(input.query ?? ""),
          maxResults: typeof input.maxResults === "number" ? input.maxResults : undefined
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
      description: "Read a bounded snippet from workspace MEMORY.md, workspace memory/YYYY-MM-DD.md, sessions/*, or global ~/.lume/MEMORY.md. Use after memory_search.",
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
        return memoryTools["memory.read"]({
          workspaceSlug: params.workspaceSlug,
          path: String(input.path ?? ""),
          from: typeof input.from === "number" ? input.from : undefined,
          lines: typeof input.lines === "number" ? input.lines : undefined
        });
      }
    }));
  }

  if (params.enabledTools.has("memory.read")) {
    tools.push(createSdkJsonResultTool({
      name: "memory.read",
      description: "Read a memory item by id, or read a bounded snippet from memory markdown by path and line range.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          path: { type: "string" },
          from: { type: "number", minimum: 1 },
          lines: { type: "number", minimum: 1, maximum: 2000 }
        }
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      async call(input) {
        return memoryTools["memory.read"]({
          workspaceSlug: params.workspaceSlug,
          id: typeof input.id === "string" ? input.id : undefined,
          path: typeof input.path === "string" ? input.path : undefined,
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
        return writeWorkspaceMemory({
          workspaceSlug: params.workspaceSlug,
          content: String(input.content ?? ""),
          path: typeof input.path === "string" ? input.path : undefined,
          date: typeof input.date === "string" ? input.date : undefined
        });
      }
    }));
  }

  if (params.enabledTools.has("memory.remember")) {
    tools.push(createSdkJsonResultTool({
      name: "memory.remember",
      description: "Store one durable structured memory item when the user asks you to remember something or when a durable decision/preference/fact appears.",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["global", "workspace", "agent", "session"] },
          kind: { type: "string", enum: ["raw", "summary", "fact", "preference", "decision", "episode", "lesson", "milestone", "artifact"] },
          content: { type: "string", minLength: 1 },
          title: { type: "string" },
          importance: { type: "number", minimum: 1, maximum: 5 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          tags: { type: "array", items: { type: "string" } },
          sourceMessageIds: { type: "array", items: { type: "string" } },
          requireReview: { type: "boolean" }
        },
        required: ["scope", "kind", "content"]
      },
      async call(input) {
        return memoryTools["memory.remember"]({
          workspaceSlug: params.workspaceSlug,
          scope: String(input.scope ?? "workspace") as MemoryScope,
          kind: String(input.kind ?? "fact") as MemoryKind,
          content: String(input.content ?? ""),
          title: typeof input.title === "string" ? input.title : undefined,
          importance: optionalImportance(input.importance),
          confidence: typeof input.confidence === "number" ? input.confidence : undefined,
          tags: optionalStringArray(input.tags),
          sourceMessageIds: optionalStringArray(input.sourceMessageIds),
          requireReview: typeof input.requireReview === "boolean" ? input.requireReview : undefined
        });
      }
    }));
  }

  if (params.enabledTools.has("memory.writeEpisode")) {
    tools.push(createSdkJsonResultTool({
      name: "memory.writeEpisode",
      description: "Record a completed task or meaningful collaboration episode, optionally splitting decisions, preferences, and lessons into structured memory items.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          title: { type: "string", minLength: 1 },
          summary: { type: "string", minLength: 1 },
          outcomes: { type: "array", items: { type: "string" } },
          decisions: { type: "array", items: { type: "string" } },
          preferences: { type: "array", items: { type: "string" } },
          lessons: { type: "array", items: { type: "string" } },
          nextSteps: { type: "array", items: { type: "string" } },
          sourceMessageIds: { type: "array", items: { type: "string" } }
        },
        required: ["sessionId", "title", "summary"]
      },
      async call(input) {
        return memoryTools["memory.writeEpisode"]({
          workspaceSlug: params.workspaceSlug,
          sessionId: String(input.sessionId ?? ""),
          title: String(input.title ?? ""),
          summary: String(input.summary ?? ""),
          outcomes: optionalStringArray(input.outcomes),
          decisions: optionalStringArray(input.decisions),
          preferences: optionalStringArray(input.preferences),
          lessons: optionalStringArray(input.lessons),
          nextSteps: optionalStringArray(input.nextSteps),
          sourceMessageIds: optionalStringArray(input.sourceMessageIds)
        });
      }
    }));
  }

  if (params.enabledTools.has("memory.flush")) {
    tools.push(createSdkJsonResultTool({
      name: "memory.flush",
      description: "Persist structured durable memory entries before context compaction.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", minLength: 1 },
          entries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["episode", "decision", "preference", "fact", "lesson"] },
                title: { type: "string" },
                content: { type: "string", minLength: 1 },
                importance: { type: "number", minimum: 1, maximum: 5 },
                tags: { type: "array", items: { type: "string" } },
                sourceMessageIds: { type: "array", items: { type: "string" } }
              },
              required: ["kind", "content", "importance"]
            }
          }
        },
        required: ["sessionId", "entries"]
      },
      async call(input) {
        const entries = Array.isArray(input.entries) ? input.entries : [];
        return memoryTools["memory.flush"]({
          workspaceSlug: params.workspaceSlug,
          sessionId: String(input.sessionId ?? ""),
          entries: entries.map((entry) => {
            const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
            return {
              kind: String(record.kind ?? "episode") as "episode" | "decision" | "preference" | "fact" | "lesson",
              ...(typeof record.title === "string" ? { title: record.title } : {}),
              content: String(record.content ?? ""),
              importance: optionalImportance(record.importance) ?? 3,
              tags: optionalStringArray(record.tags),
              sourceMessageIds: optionalStringArray(record.sourceMessageIds)
            };
          })
        });
      }
    }));
  }

  if (params.enabledTools.has("memory.distillWorkspace")) {
    tools.push(createSdkJsonResultTool({
      name: "memory.distillWorkspace",
      description: "Distill recent daily/session memories into workspace long-term memory and workspace brief. Prefer user-triggered maintenance.",
      inputSchema: {
        type: "object",
        properties: {
          days: { type: "number", minimum: 1, maximum: 90 },
          dryRun: { type: "boolean" },
          updateWorkspaceBrief: { type: "boolean" },
          generateGlobalCandidates: { type: "boolean" }
        }
      },
      async call(input) {
        return memoryTools["memory.distillWorkspace"]({
          workspaceSlug: params.workspaceSlug,
          days: typeof input.days === "number" ? input.days : undefined,
          dryRun: typeof input.dryRun === "boolean" ? input.dryRun : undefined,
          updateWorkspaceBrief: typeof input.updateWorkspaceBrief === "boolean" ? input.updateWorkspaceBrief : undefined,
          generateGlobalCandidates: typeof input.generateGlobalCandidates === "boolean" ? input.generateGlobalCandidates : undefined
        });
      }
    }));
  }

  if (params.enabledTools.has("memory.listGlobalCandidates")) {
    tools.push(createSdkJsonResultTool({
      name: "memory.listGlobalCandidates",
      description: "List generated global memory candidates. Read-only; promotion still requires explicit approval.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["pending", "approved", "rejected", "ignored"] }
        }
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      async call(input) {
        return memoryTools["memory.listGlobalCandidates"]({
          status: input.status === "pending" || input.status === "approved" || input.status === "rejected" || input.status === "ignored"
            ? input.status
            : undefined
        });
      }
    }));
  }

  if (params.enabledTools.has("memory.promoteGlobal")) {
    tools.push(createSdkJsonResultTool({
      name: "memory.promoteGlobal",
      description: "Promote an approved candidate into global memory. Use only after explicit user confirmation.",
      inputSchema: {
        type: "object",
        properties: {
          candidateId: { type: "string", minLength: 1 },
          approve: { type: "boolean" },
          editedContent: { type: "string" }
        },
        required: ["candidateId", "approve"]
      },
      async call(input) {
        return memoryTools["memory.promoteGlobal"]({
          candidateId: String(input.candidateId ?? ""),
          approve: input.approve === true,
          editedContent: typeof input.editedContent === "string" ? input.editedContent : undefined
        });
      }
    }));
  }

  if (params.enabledTools.has("memory.rejectGlobalCandidate")) {
    tools.push(createSdkJsonResultTool({
      name: "memory.rejectGlobalCandidate",
      description: "Reject a global memory candidate after user confirmation.",
      inputSchema: {
        type: "object",
        properties: {
          candidateId: { type: "string", minLength: 1 }
        },
        required: ["candidateId"]
      },
      async call(input) {
        return memoryTools["memory.rejectGlobalCandidate"]({
          candidateId: String(input.candidateId ?? "")
        });
      }
    }));
  }

  if (params.enabledTools.has("memory.status")) {
    tools.push(createSdkJsonResultTool({
      name: "memory.status",
      description: "Return workspace memory provider/index status.",
      inputSchema: { type: "object", properties: {} },
      isReadOnly: true,
      isConcurrencySafe: true,
      async call() {
        return memoryTools["memory.status"]({ workspaceSlug: params.workspaceSlug });
      }
    }));
  }

  if (params.enabledTools.has("memory.indexWorkspace")) {
    tools.push(createSdkJsonResultTool({
      name: "memory.indexWorkspace",
      description: "Rebuild or refresh the workspace memory index.",
      inputSchema: {
        type: "object",
        properties: {
          force: { type: "boolean" }
        }
      },
      async call(input) {
        return memoryTools["memory.indexWorkspace"]({
          workspaceSlug: params.workspaceSlug,
          force: typeof input.force === "boolean" ? input.force : undefined
        });
      }
    }));
  }

  if (params.enabledTools.has("memory.indexDocument")) {
    tools.push(createSdkJsonResultTool({
      name: "memory.indexDocument",
      description: "Rebuild memory index for a single workspace memory document such as WORKSPACE.md, MEMORY.md, or memory/YYYY-MM-DD.md.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", minLength: 1 },
          force: { type: "boolean" }
        },
        required: ["filePath"]
      },
      async call(input) {
        return memoryTools["memory.indexDocument"]({
          workspaceSlug: params.workspaceSlug,
          filePath: String(input.filePath ?? ""),
          force: typeof input.force === "boolean" ? input.force : undefined
        });
      }
    }));
  }

  return tools;
}
