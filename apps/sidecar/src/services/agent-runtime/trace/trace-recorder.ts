import { randomUUID } from "node:crypto";
import type { LumeSpanType, LumeTrace, LumeTraceSpan } from "./trace-types";
import type { LumeTraceStore } from "./trace-store";

export interface StartTraceInput {
  threadId: string;
  runId: string;
  workspaceId?: string;
  name: string;
  metadata?: Record<string, unknown>;
}

export interface StartSpanInput {
  traceId: string;
  parentId?: string;
  type: LumeSpanType;
  name: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
}

interface TraceRecorderOptions {
  createId?: () => string;
  now?: () => string;
}

export class TraceRecorder {
  private readonly createId: () => string;
  private readonly now: () => string;
  private readonly spanTraceIds = new Map<string, string>();

  constructor(
    private readonly store: LumeTraceStore,
    options: TraceRecorderOptions = {}
  ) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async startTrace(input: StartTraceInput): Promise<LumeTrace> {
    const trace: LumeTrace = {
      id: this.createId(),
      threadId: input.threadId,
      runId: input.runId,
      workspaceId: input.workspaceId,
      name: input.name,
      status: "running",
      startedAt: this.now(),
      spans: [],
      metadata: input.metadata
    };
    await this.store.create(trace);
    return trace;
  }

  async endTrace(traceId: string, status: LumeTrace["status"]): Promise<void> {
    await this.store.update(traceId, {
      status,
      endedAt: this.now()
    });
  }

  async startSpan(input: StartSpanInput): Promise<LumeTraceSpan> {
    const span: LumeTraceSpan = {
      id: this.createId(),
      traceId: input.traceId,
      parentId: input.parentId,
      type: input.type,
      name: input.name,
      status: "running",
      startedAt: this.now(),
      input: input.input,
      metadata: input.metadata
    };
    await this.store.appendSpan(input.traceId, span);
    this.spanTraceIds.set(span.id, input.traceId);
    return span;
  }

  async endSpan(spanId: string, output?: unknown): Promise<void> {
    const span = await this.findSpan(spanId);
    if (!span) return;
    const endedAt = this.now();
    await this.store.updateSpan(span.traceId, spanId, {
      status: "completed",
      endedAt,
      durationMs: calculateDurationMs(span.startedAt, endedAt),
      output
    });
  }

  async failSpan(spanId: string, error: unknown): Promise<void> {
    const span = await this.findSpan(spanId);
    if (!span) return;
    const endedAt = this.now();
    await this.store.updateSpan(span.traceId, spanId, {
      status: "failed",
      endedAt,
      durationMs: calculateDurationMs(span.startedAt, endedAt),
      error: normalizeError(error)
    });
  }

  async withSpan<T>(input: StartSpanInput, fn: () => Promise<T>): Promise<T> {
    const span = await this.startSpan(input);
    try {
      const result = await fn();
      await this.endSpan(span.id, result);
      return result;
    } catch (error) {
      await this.failSpan(span.id, error);
      throw error;
    }
  }

  private async findSpan(spanId: string): Promise<LumeTraceSpan | null> {
    const traceId = this.spanTraceIds.get(spanId);
    if (traceId) {
      const trace = await this.store.get(traceId);
      return trace?.spans.find((item) => item.id === spanId) ?? null;
    }
    // Spans are stored inside trace documents; trace ids are not globally indexed yet.
    // Runtime integration keeps span ids scoped to the active trace, so this method
    // scans only traces in the current session store.
    const anyStore = this.store as unknown as { listByThread?: (threadId: string) => Promise<LumeTrace[]> };
    if (!anyStore.listByThread) return null;
    const knownTraces = await collectKnownTraces(this.store);
    for (const trace of knownTraces) {
      const span = trace.spans.find((item) => item.id === spanId);
      if (span) return span;
    }
    return null;
  }
}

async function collectKnownTraces(store: LumeTraceStore): Promise<LumeTrace[]> {
  const internals = store as unknown as { tracesDir?: string };
  if (!internals.tracesDir) return [];
  const { readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const traces: LumeTrace[] = [];
  for (const file of readdirSync(internals.tracesDir)) {
    if (!file.endsWith(".json")) continue;
    const traceId = file.slice(0, -".json".length);
    const trace = await store.get(traceId);
    if (trace) traces.push(trace);
  }
  return traces;
}

function calculateDurationMs(startedAt: string, endedAt: string): number {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

function normalizeError(error: unknown): LumeTraceSpan["error"] {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack
    };
  }
  return { message: String(error) };
}
