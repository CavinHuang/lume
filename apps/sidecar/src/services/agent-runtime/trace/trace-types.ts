export interface LumeTrace {
  schemaVersion?: 2;
  id: string;
  correlationTraceId?: string;
  parentCorrelationTraceId?: string;
  linkedCorrelationTraceId?: string;
  threadId: string;
  runId: string;
  workspaceId?: string;
  name: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  endedAt?: string;
  spans: LumeTraceSpan[];
  metadata?: Record<string, unknown>;
}

export type LumeSpanType =
  | "run"
  | "agent"
  | "context_assembly"
  | "memory_retrieval"
  | "model_call"
  | "tool_call"
  | "guardrail"
  | "handoff"
  | "subagent"
  | "approval"
  | "session_persist"
  | "compaction";

export interface LumeTraceSpan {
  id: string;
  traceId: string;
  parentId?: string;
  type: LumeSpanType;
  name: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: {
    message: string;
    code?: string;
    stack?: string;
  };
  metadata?: Record<string, unknown>;
}
