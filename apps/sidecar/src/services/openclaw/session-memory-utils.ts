/**
 * Migrated from:
 * /Users/cavinhuang/workspace/projects/test/openclaw/src/memory/session-files.ts
 * Adaptation:
 * - Keep core extraction logic for session text flattening.
 * - Support both OpenClaw-style wrapped records and Lume's plain AgentMessage JSONL rows.
 */

export interface ParsedSessionMessage {
  role: "user" | "assistant";
  content: unknown;
}

export function normalizeSessionText(value: string): string {
  return value
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractSessionText(content: unknown): string | null {
  if (typeof content === "string") {
    const normalized = normalizeSessionText(content);
    return normalized ? normalized : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") {
      continue;
    }
    const normalized = normalizeSessionText(record.text);
    if (normalized) {
      parts.push(normalized);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" ");
}

export function parseSessionMessageRecord(record: unknown): ParsedSessionMessage | null {
  if (!record || typeof record !== "object") return null;

  // OpenClaw wrapped JSONL record: { type: "message", message: { role, content } }
  if ((record as { type?: unknown }).type === "message") {
    const wrapped = (record as { message?: unknown }).message as
      | { role?: unknown; content?: unknown }
      | undefined;
    if (!wrapped || typeof wrapped.role !== "string") return null;
    if (wrapped.role !== "user" && wrapped.role !== "assistant") return null;
    return { role: wrapped.role, content: wrapped.content };
  }

  // Lume JSONL row: { role, content, ... }
  const plain = record as { role?: unknown; content?: unknown };
  if (plain.role !== "user" && plain.role !== "assistant") return null;
  return { role: plain.role, content: plain.content };
}
