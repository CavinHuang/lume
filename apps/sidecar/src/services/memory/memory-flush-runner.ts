import type {
  MemoryFlushEntry,
  MemoryFlushPayload,
  MemoryFlushResult,
  MemoryKind,
  MemorySaveInput,
  MemorySaveResult,
  MemoryScope
} from "@lume/shared";
import { writeWorkspaceMemory } from "./memory-service";

const VALID_KINDS = new Set<MemoryKind>([
  "raw",
  "summary",
  "fact",
  "preference",
  "decision",
  "episode",
  "lesson",
  "milestone",
  "artifact"
]);

const VALID_SCOPES = new Set<MemoryScope>(["global", "workspace", "agent", "session"]);

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

function clampImportance(value: unknown): 1 | 2 | 3 | 4 | 5 {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 3;
  return Math.min(5, Math.max(1, n)) as 1 | 2 | 3 | 4 | 5;
}

function normalizeConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function normalizeEntry(value: unknown): MemoryFlushEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const content = typeof raw.content === "string" ? raw.content.trim() : "";
  if (!content) return null;

  const kind = typeof raw.kind === "string" && VALID_KINDS.has(raw.kind as MemoryKind)
    ? raw.kind as MemoryKind
    : undefined;
  if (!kind) return null;

  const scope = typeof raw.scope === "string" && VALID_SCOPES.has(raw.scope as MemoryScope)
    ? raw.scope as MemoryScope
    : undefined;

  return {
    kind,
    ...(scope ? { scope } : {}),
    ...(typeof raw.title === "string" && raw.title.trim() ? { title: raw.title.trim() } : {}),
    content,
    ...(typeof raw.summary === "string" && raw.summary.trim() ? { summary: raw.summary.trim() } : {}),
    importance: clampImportance(raw.importance),
    ...(normalizeConfidence(raw.confidence) !== undefined ? { confidence: normalizeConfidence(raw.confidence) } : {}),
    ...(normalizeStringArray(raw.tags) ? { tags: normalizeStringArray(raw.tags) } : {}),
    ...(normalizeStringArray(raw.entities) ? { entities: normalizeStringArray(raw.entities) } : {}),
    ...(normalizeStringArray(raw.topics) ? { topics: normalizeStringArray(raw.topics) } : {}),
    ...(normalizeStringArray(raw.sourceMessageIds) ? { sourceMessageIds: normalizeStringArray(raw.sourceMessageIds) } : {})
  };
}

export function parseMemoryFlushPayload(params: {
  workspaceSlug: string;
  sessionId: string;
  rawOutput: string;
}): { payload: MemoryFlushPayload; skippedCount: number } {
  const text = params.rawOutput.trim();
  if (!text || text === "NO_REPLY") {
    return {
      payload: { workspaceSlug: params.workspaceSlug, sessionId: params.sessionId, entries: [] },
      skippedCount: 0
    };
  }

  const parsed = JSON.parse(stripJsonFence(text)) as unknown;
  const entriesRaw = parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries)
    ? (parsed as { entries: unknown[] }).entries
    : [];
  const entries: MemoryFlushEntry[] = [];
  let skippedCount = 0;

  for (const rawEntry of entriesRaw) {
    const entry = normalizeEntry(rawEntry);
    if (!entry) {
      skippedCount += 1;
      continue;
    }
    entries.push(entry);
  }

  return {
    payload: {
      workspaceSlug: params.workspaceSlug,
      sessionId: params.sessionId,
      entries
    },
    skippedCount
  };
}

export async function runStructuredMemoryFlush(params: {
  workspaceSlug: string;
  sessionId: string;
  rawOutput: string;
  deps?: {
    writeWorkspaceMemory?: (input: MemorySaveInput) => Promise<MemorySaveResult>;
  };
}): Promise<MemoryFlushResult> {
  let parsed: { payload: MemoryFlushPayload; skippedCount: number };
  try {
    parsed = parseMemoryFlushPayload({
      workspaceSlug: params.workspaceSlug,
      sessionId: params.sessionId,
      rawOutput: params.rawOutput
    });
  } catch (error) {
    return {
      executed: true,
      reason: error instanceof Error ? error.message : String(error),
      payload: { workspaceSlug: params.workspaceSlug, sessionId: params.sessionId, entries: [] },
      savedCount: 0,
      skippedCount: 0
    };
  }

  const writer = params.deps?.writeWorkspaceMemory ?? writeWorkspaceMemory;
  let savedCount = 0;
  let skippedCount = parsed.skippedCount;

  for (const entry of parsed.payload.entries) {
    try {
      await writer({
        workspaceSlug: params.workspaceSlug,
        content: entry.content,
        scope: entry.scope ?? "workspace",
        kind: entry.kind,
        source: "flush",
        title: entry.title,
        summary: entry.summary,
        tags: entry.tags,
        entities: entry.entities,
        topics: entry.topics,
        importance: entry.importance,
        confidence: entry.confidence,
        sourceSessionId: params.sessionId,
        sourceMessageIds: entry.sourceMessageIds
      });
      savedCount += 1;
    } catch {
      skippedCount += 1;
    }
  }

  return {
    executed: true,
    payload: parsed.payload,
    savedCount,
    skippedCount
  };
}
