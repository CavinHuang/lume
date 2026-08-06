import type { ToolDefinition } from "@lume/agent-sdk";
import type { MemoryClaim, MemoryEvidenceRef, MemoryKind, MemoryMutationActor, MemoryScopeInput, MemorySearchResult } from "@lume/shared";
import {
  forgetMemoryTool,
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

function memoryV2RememberScope(value: unknown): MemoryScopeInput {
  return value === "global" || value === "workspace" ? value : "auto";
}

function optionalStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue === "string") out[key] = rawValue;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function optionalEvidenceRefs(value: unknown): MemoryEvidenceRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const type = record.type;
    if (type !== "user_message" && type !== "assistant_message" && type !== "tool_result" && type !== "external_file" && type !== "manual" && type !== "consolidation") return [];
    return [{
      type: type as MemoryEvidenceRef["type"],
      ...(typeof record.id === "string" ? { id: record.id } : {}),
      ...(typeof record.quote === "string" ? { quote: record.quote } : {}),
      ...(typeof record.path === "string" ? { path: record.path } : {})
    }];
  });
  return refs.length > 0 ? refs : undefined;
}

export function createSdkMemoryTools(params: {
  workspaceSlug: string;
  enabledTools: Set<string>;
  includeCitations: boolean;
  threadId?: string;
  runId?: string;
  actor?: MemoryMutationActor;
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
          scope: { type: "string", enum: ["auto", "global", "workspace"], default: "auto" },
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
          evidenceRefs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["user_message", "assistant_message", "tool_result", "external_file", "manual", "consolidation"] },
                id: { type: "string" },
                path: { type: "string" },
                quote: { type: "string" }
              },
              required: ["type"]
            }
          },
          explicitCorrection: { type: "boolean", description: "Set true only when the user explicitly corrects an existing claim." },
          requireReview: { type: "boolean" }
        },
        required: ["content"]
      },
      async call(input) {
        return rememberMemoryTool({
          workspaceSlug: params.workspaceSlug,
          scope: memoryV2RememberScope(input.scope),
          // Legacy callers may still send kind; it is intentionally absent from the public schema.
          kind: typeof input.kind === "string" ? input.kind as MemoryKind : undefined,
          content: String(input.content ?? ""),
          title: typeof input.title === "string" ? input.title : undefined,
          importance: optionalImportance(input.importance),
          confidence: typeof input.confidence === "number" ? input.confidence : undefined,
          tags: optionalStringArray(input.tags),
          claim: optionalClaim(input.claim),
          sourceMessageIds: optionalStringArray(input.sourceMessageIds),
          evidenceRefs: optionalEvidenceRefs(input.evidenceRefs),
          sourceSessionId: params.runId,
          threadId: params.threadId,
          actor: params.actor,
          explicitCorrection: typeof input.explicitCorrection === "boolean" ? input.explicitCorrection : undefined,
          requireReview: typeof input.requireReview === "boolean" ? input.requireReview : undefined
        });
      }
    }));
  }

  if (params.enabledTools.has("memory.forget")) {
    tools.push(createSdkJsonResultTool({
      name: "memory.forget",
      description: "Reversibly archive one memory only when the user explicitly asks to forget that exact item. Search first to obtain its id.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          scope: { type: "string", enum: ["global", "workspace"] },
          explicitUserIntent: { type: "boolean", const: true }
        },
        required: ["id", "explicitUserIntent"]
      },
      async call(input) {
        return forgetMemoryTool({
          workspaceSlug: params.workspaceSlug,
          id: String(input.id ?? ""),
          scope: input.scope === "global" || input.scope === "workspace" ? input.scope : undefined,
          explicitUserIntent: true,
          sourceSessionId: params.runId,
          threadId: params.threadId
        });
      }
    }));
  }

  return tools;
}
