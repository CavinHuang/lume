import type { LumeTrace, LumeTraceSpan } from "./trace-types";

export type TraceRedactionLevel = "safe_summary" | "diagnostic" | "raw_internal";

const REDACTED_PAYLOAD = "[REDACTED_PAYLOAD]" as const;
const REDACTED = "[REDACTED]" as const;

export function redactTraceForLevel(trace: LumeTrace, level: TraceRedactionLevel): LumeTrace {
  if (level === "raw_internal") {
    return cloneJson(trace);
  }

  return {
    ...trace,
    metadata: redactTracePayload(trace.metadata, "diagnostic") as Record<string, unknown> | undefined,
    spans: trace.spans.map((span) => redactSpan(span, level))
  };
}

export function redactTracePayload(value: unknown, level: Exclude<TraceRedactionLevel, "raw_internal">): unknown {
  if (level === "safe_summary") return REDACTED_PAYLOAD;
  return sanitizeDiagnosticPayload(value);
}

function redactSpan(span: LumeTraceSpan, level: Exclude<TraceRedactionLevel, "raw_internal">): LumeTraceSpan {
  return {
    ...span,
    input: redactTracePayload(span.input, level),
    output: redactTracePayload(span.output, level),
    error: span.error ? {
      ...span.error,
      message: redactTraceString(span.error.message),
      stack: span.error.stack ? redactTraceString(span.error.stack) : undefined
    } : undefined,
    metadata: redactTracePayload(span.metadata, "diagnostic") as Record<string, unknown> | undefined
  };
}

function sanitizeDiagnosticPayload(value: unknown): unknown {
  if (typeof value === "string") return redactTraceString(truncateTraceString(value));
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(sanitizeDiagnosticPayload);
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = isSensitiveTraceKey(key) ? REDACTED : sanitizeDiagnosticPayload(entry);
  }
  return output;
}

export function summarizeTraceOutput(value: unknown): string {
  if (typeof value === "string") return redactTraceString(truncateTraceString(value));
  try {
    return redactTraceString(truncateTraceString(JSON.stringify(sanitizeDiagnosticPayload(value))));
  } catch {
    return redactTraceString(String(value));
  }
}

function truncateTraceString(value: string): string {
  return value.length > 2000 ? `${value.slice(0, 2000)}...(truncated)` : value;
}

function redactTraceString(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED)
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, REDACTED)
    .replace(/((?:api[_-]?key|token|secret|private[_-]?key|password)\s*[=:]\s*)[^\s"'`,;]+/gi, `$1${REDACTED}`);
}

function isSensitiveTraceKey(key: string): boolean {
  return /(?:api[_-]?key|token|secret|private[_-]?key|password)/i.test(key);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
