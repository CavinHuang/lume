import { inspect } from "node:util";

function normalizeRecord(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const entries = Object.entries(input).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

function normalizeUnknown(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {})
    };
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeUnknown(item, seen));
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [key, normalizeUnknown(entry, seen)])
    );
  }
  return value;
}

function serializeUnknown(value: unknown): string {
  const normalized = normalizeUnknown(value);
  try {
    return JSON.stringify(normalized);
  } catch {
    return inspect(normalized, { depth: 4, breakLength: Infinity, compact: true });
  }
}

function joinMessageAndData(message: string, data?: unknown): string {
  if (data === undefined) return message;
  return message.endsWith(":") ? `${message} ${serializeUnknown(data)}` : `${message}: ${serializeUnknown(data)}`;
}

export function formatStructuredLogLine(input: {
  source: string;
  context: string;
  message: string;
  data?: Record<string, unknown>;
}): string {
  const normalizedData = normalizeRecord(input.data);
  const body = joinMessageAndData(input.message.trim(), normalizedData);
  return `[${input.source}] [${input.context}] ${body}`;
}

export function formatConsoleArgs(input: {
  source: string;
  context: string;
  args: unknown[];
}): string {
  const [first, ...rest] = input.args;
  if (typeof first === "string" && first.trim().length > 0) {
    const data = rest.length === 0 ? undefined : rest.length === 1 ? rest[0] : rest;
    return `[${input.source}] [${input.context}] ${joinMessageAndData(first.trim(), data)}`;
  }
  if (first === undefined) {
    return `[${input.source}] [${input.context}]`;
  }
  const payload = rest.length === 0 ? first : [first, ...rest];
  return `[${input.source}] [${input.context}] ${serializeUnknown(payload)}`;
}

