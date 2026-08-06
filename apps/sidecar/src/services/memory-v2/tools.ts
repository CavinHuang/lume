import { existsSync, readFileSync } from "node:fs";
import type {
  MemoryReadToolInput,
  MemoryReadToolResult,
  MemoryForgetToolInput,
  MemoryRememberToolInput,
  MemorySearchResult,
  MemorySearchToolInput,
  MemoryToolName,
  MemoryToolWriteResult
} from "@lume/shared";
import { createMemoryV2Store } from "./markdown-store";
import { searchMemoryV2 } from "./retrieval";
import { extractExplicitMemoryCandidates } from "./extraction";
import { claimFromEntry, inferMemoryV2Claim, normalizeMemoryV2Claim } from "./claim";
import type { MemoryV2Candidate, MemoryV2Kind, MemoryV2Scope } from "./types";
import { memoryFileRefForPath } from "./source-files";
import { MemoryCommandService, toSharedMemoryReceipt } from "./command-service";

export const MEMORY_V2_TOOL_NAMES = [
  "memory.search",
  "memory.read",
  "memory.remember",
  "memory.forget"
] as const satisfies readonly MemoryToolName[];

export async function searchMemoryTool(input: MemorySearchToolInput): Promise<MemorySearchResult[]> {
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
    ...fileRefField(item.scope, input.workspaceSlug, item.citation),
    score: item.score,
    kind: fromMemoryV2Kind(item.kind),
    scope: item.scope,
    source: "memory",
    reason: item.reason,
    claim: item.claim
  }));
}

export async function readMemoryTool(input: MemoryReadToolInput): Promise<MemoryReadToolResult> {
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
        confidence: confidenceNumber(entry.frontmatter.confidence),
        claim: claimFromEntry(entry)
      },
      citation: entry.path,
      ...fileRefField(entry.frontmatter.scope, input.workspaceSlug, entry.path)
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
    citation: input.from ? `${input.path}#L${input.from}` : input.path,
    ...fileRefFieldForAnyScope(input.workspaceSlug, input.path)
  };
}

function fileRefField(scope: "workspace" | "global", workspaceSlug: string, path: string) {
  const fileRef = memoryFileRefForPath({ scope, workspaceSlug, path });
  return fileRef ? { fileRef } : {};
}

function fileRefFieldForAnyScope(workspaceSlug: string, path: string) {
  const workspace = fileRefField("workspace", workspaceSlug, path);
  return workspace.fileRef ? workspace : fileRefField("global", workspaceSlug, path);
}

export async function rememberMemoryTool(input: MemoryRememberToolInput): Promise<MemoryToolWriteResult> {
  const scope = input.scope === "auto" || input.scope === undefined ? "workspace" : toMemoryV2Scope(input.scope);
  const kind = toMemoryV2Kind(input.kind);
  const candidate = normalizeRememberCandidate(input, scope, kind);
  const sourceMessageRefs = input.sourceMessageIds?.map((id) => ({
    type: "user_message" as const,
    id,
    runId: input.sourceSessionId,
    threadId: input.threadId
  })) ?? [];
  const evidenceRefs = [...sourceMessageRefs, ...(input.evidenceRefs ?? [])];
  const receipt = await new MemoryCommandService().remember({
    workspaceSlug: input.workspaceSlug,
    content: candidate.statement,
    scope: input.scope ?? "auto",
    legacyKind: input.kind,
    semanticRole: candidate.semanticRole,
    facets: candidate.facets ?? candidate.tags,
    confidence: candidate.confidence,
    claim: candidate.claim,
    evidenceRefs: evidenceRefs.length > 0 ? evidenceRefs : undefined,
    actor: input.actor ?? "main_agent",
    runId: input.sourceSessionId,
    threadId: input.threadId,
    explicitCorrection: input.explicitCorrection
  });
  const entry = receipt.memoryIds.length > 0
    ? createMemoryV2Store().listEntries({ workspaceSlug: input.workspaceSlug, includeStatuses: ["active", "suspected_stale", "superseded", "archived"] })
      .find((item) => item.frontmatter.id === receipt.memoryIds[0])
    : undefined;
  return {
    ...toSharedMemoryReceipt(receipt),
    workspaceSlug: input.workspaceSlug,
    ...(entry ? {
      id: entry.frontmatter.id,
      path: entry.path,
      kind: fromMemoryV2Kind(entry.frontmatter.kind),
      evidenceRefs: entry.frontmatter.evidence_refs
    } : {})
  };
}

export async function forgetMemoryTool(input: MemoryForgetToolInput): Promise<MemoryToolWriteResult> {
  if (input.explicitUserIntent !== true) {
    throw new Error("memory.forget 只能响应用户明确的遗忘请求");
  }
  const service = new MemoryCommandService();
  const receipt = service.archive({
    workspaceSlug: input.workspaceSlug,
    id: input.id,
    scope: input.scope,
    actor: "main_agent",
    runId: input.sourceSessionId,
    threadId: input.threadId
  });
  const entry = createMemoryV2Store().listEntries({
    workspaceSlug: input.workspaceSlug,
    scopes: [receipt.scope],
    includeStatuses: ["archived"]
  }).find((item) => item.frontmatter.id === input.id);
  return {
    ...toSharedMemoryReceipt(receipt),
    workspaceSlug: input.workspaceSlug,
    ...(entry ? { id: entry.frontmatter.id, path: entry.path, kind: fromMemoryV2Kind(entry.frontmatter.kind) } : {})
  };
}

function normalizeRememberCandidate(
  input: MemoryRememberToolInput,
  fallbackScope: MemoryV2Scope,
  fallbackKind: MemoryV2Kind
): MemoryV2Candidate {
  const explicit = extractExplicitMemoryCandidates({
    text: input.content,
    workspaceSlug: input.workspaceSlug
  })[0];
  const targetScope = explicit?.targetScope ?? fallbackScope;
  const tags = uniqueStrings([...(explicit?.tags ?? []), ...(input.tags ?? [])]);
  return {
    targetScope,
    kind: explicit?.kind ?? fallbackKind,
    statement: explicit?.statement ?? input.content,
    confidence: explicit?.confidence ?? toMemoryV2Confidence(input.confidence),
    tags,
    entities: explicit?.entities,
    appliesWhen: explicit?.appliesWhen ?? (targetScope === "workspace" ? { workspaceSlug: input.workspaceSlug } : {}),
    claim: normalizeMemoryV2Claim(input.claim) ?? explicit?.claim ?? inferMemoryV2Claim({
      statement: explicit?.statement ?? input.content,
      tags
    }),
    evidence: {
      ...explicit?.evidence,
      runId: input.sourceSessionId,
      recordIds: input.sourceMessageIds
    }
  };
}

function defaultIncludeGlobal(input: MemorySearchToolInput): boolean {
  if (typeof input.includeGlobal === "boolean") return input.includeGlobal;
  return input.sessionType === undefined || input.sessionType === "main";
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

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function toMemoryV2Confidence(confidence?: number): "low" | "medium" | "high" {
  if (typeof confidence !== "number") return "medium";
  if (confidence >= 0.75) return "high";
  if (confidence < 0.45) return "low";
  return "medium";
}
