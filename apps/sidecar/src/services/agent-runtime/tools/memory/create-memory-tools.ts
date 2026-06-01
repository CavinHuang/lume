import type { ToolDefinition } from "@lume/agent-sdk";
import type { MemoryClaim, MemoryKind, MemoryScope, MemorySearchResult } from "@lume/shared";
import {
  readMemoryTool,
  rememberMemoryTool,
  searchMemoryTool
} from "../../../memory-v2/tools";
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

function optionalClaim(value: unknown): MemoryClaim | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.subject !== "string"
    || typeof record.predicate !== "string"
    || typeof record.object !== "string"
  ) {
    return undefined;
  }
  const qualifiers = optionalStringRecord(record.qualifiers);
  return {
    subject: record.subject,
    predicate: record.predicate,
    object: record.object,
    ...(qualifiers ? { qualifiers } : {})
  };
}

function memoryV2RememberScope(value: unknown): MemoryScope {
  return value === "global" ? "global" : "workspace";
}

function optionalStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue === "string") out[key] = rawValue;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function createSdkMemoryTools(params: {
  workspaceSlug: string;
  enabledTools: Set<string>;
  includeCitations: boolean;
}): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  if (params.enabledTools.has("memory.search")) {
    tools.push(createSdkJsonResultTool({
      name: "memory.search",
      description:
        "Search Memory V2 when the answer may depend on prior work, shared work state, what we are doing now, progress, next steps, decisions, dates, preferences, or todos. For current-state questions, a compact search is usually better than guessing. Integrate results naturally; do not treat every history-related question as a mandatory recall ritual.",
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
        const results = await searchMemoryTool({
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

  if (params.enabledTools.has("memory.read")) {
    tools.push(createSdkJsonResultTool({
      name: "memory.read",
      description: "Read a Memory V2 item by id, or read a bounded snippet from memory markdown by path and line range.",
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
        return readMemoryTool({
          workspaceSlug: params.workspaceSlug,
          id: typeof input.id === "string" ? input.id : undefined,
          path: typeof input.path === "string" ? input.path : undefined,
          from: typeof input.from === "number" ? input.from : undefined,
          lines: typeof input.lines === "number" ? input.lines : undefined
        });
      }
    }));
  }

  if (params.enabledTools.has("memory.remember")) {
    tools.push(createSdkJsonResultTool({
      name: "memory.remember",
      description: "Store one durable Memory V2 item when the user asks you to remember something or when a durable decision/preference/fact appears.",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["global", "workspace"] },
          kind: { type: "string", enum: ["raw", "summary", "fact", "preference", "decision", "episode", "lesson", "milestone", "artifact"] },
          content: { type: "string", minLength: 1 },
          title: { type: "string" },
          importance: { type: "number", minimum: 1, maximum: 5 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          tags: { type: "array", items: { type: "string" } },
          claim: {
            type: "object",
            properties: {
              subject: { type: "string" },
              predicate: { type: "string" },
              object: { type: "string" },
              qualifiers: {
                type: "object",
                additionalProperties: { type: "string" }
              }
            },
            required: ["subject", "predicate", "object"]
          },
          sourceMessageIds: { type: "array", items: { type: "string" } },
          requireReview: { type: "boolean" }
        },
        required: ["scope", "kind", "content"]
      },
      async call(input) {
        return rememberMemoryTool({
          workspaceSlug: params.workspaceSlug,
          scope: memoryV2RememberScope(input.scope),
          kind: String(input.kind ?? "fact") as MemoryKind,
          content: String(input.content ?? ""),
          title: typeof input.title === "string" ? input.title : undefined,
          importance: optionalImportance(input.importance),
          confidence: typeof input.confidence === "number" ? input.confidence : undefined,
          tags: optionalStringArray(input.tags),
          claim: optionalClaim(input.claim),
          sourceMessageIds: optionalStringArray(input.sourceMessageIds),
          requireReview: typeof input.requireReview === "boolean" ? input.requireReview : undefined
        });
      }
    }));
  }

  return tools;
}
