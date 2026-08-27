import { randomUUID } from "node:crypto";
import type { LumeSpanType, LumeTrace, LumeTraceSpan } from "./trace-types";
import type { LumeTraceStore } from "./trace-store";

export interface StartTraceInput {
  threadId: string;
  runId: string;
  workspaceId?: string;
  name: string;
  metadata?: Record<string, unknown>;
  correlationTraceId?: string;
  parentCorrelationTraceId?: string;
  linkedCorrelationTraceId?: string;
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
  onEvent?: (event: TraceRecorderEvent) => void;
}

export type TraceRecorderEvent =
  | { type: "trace.started"; trace: LumeTrace }
  | { type: "trace.ended"; trace: LumeTrace }
  | { type: "span.started"; trace: LumeTrace; span: LumeTraceSpan }
  | { type: "span.ended"; trace: LumeTrace; span: LumeTraceSpan };

export class TraceRecorder {
  private readonly createId: () => string;
  private readonly now: () => string;
  /**
   * 内存缓存：recorder 是本 session 内 span/trace 的唯一写方，缓存对象即磁盘最后版本。
   * 避免每次 span 操作全量解析 spans.jsonl（O(n²)）。startSpan 返回值与缓存同引用，
   * 消费方（run-observer 等）视作只读。endTrace 时随 trace 一并清理（Map 迭代中删当前项安全）。
   */
  private readonly traces = new Map<string, LumeTrace>();
  private readonly spans = new Map<string, LumeTraceSpan>();
  private readonly onEvent?: (event: TraceRecorderEvent) => void;

  constructor(
    private readonly store: LumeTraceStore,
    options: TraceRecorderOptions = {}
  ) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onEvent = options.onEvent;
  }

  async startTrace(input: StartTraceInput): Promise<LumeTrace> {
    const trace: LumeTrace = {
      schemaVersion: 2,
      id: this.createId(),
      correlationTraceId: input.correlationTraceId,
      parentCorrelationTraceId: input.parentCorrelationTraceId,
      linkedCorrelationTraceId: input.linkedCorrelationTraceId,
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
    this.traces.set(trace.id, trace);
    this.onEvent?.({ type: "trace.started", trace });
    return trace;
  }

  async endTrace(traceId: string, status: LumeTrace["status"]): Promise<void> {
    // 每 run 一次，保留读盘取完整 trace
    const trace = await this.store.get(traceId);
    const endedAt = this.now();
    await this.store.update(traceId, {
      status,
      endedAt
    });
    if (trace) this.onEvent?.({ type: "trace.ended", trace: { ...trace, status, endedAt } });
    this.traces.delete(traceId);
    for (const [spanId, span] of this.spans) {
      if (span.traceId === traceId) this.spans.delete(spanId);
    }
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
    this.spans.set(span.id, span);
    // onEvent 消费方只读 trace 的 id/runId/threadId 等标识字段，不读 spans 新鲜度
    const trace = this.traces.get(input.traceId);
    if (trace) {
      this.onEvent?.({ type: "span.started", trace, span });
      return span;
    }
    const loaded = await this.store.get(input.traceId);
    if (loaded) this.onEvent?.({ type: "span.started", trace: loaded, span });
    return span;
  }

  async endSpan(spanId: string, output?: unknown): Promise<void> {
    const cached = this.spans.get(spanId);
    if (cached) {
      const endedAt = this.now();
      const ended: LumeTraceSpan = {
        ...cached,
        status: "completed",
        endedAt,
        durationMs: calculateDurationMs(cached.startedAt, endedAt),
        output
      };
      this.spans.set(spanId, ended);
      // 追加完整终态版本：readSpans 同 id 后行覆盖前行，与 updateSpan 等价
      await this.store.appendSpan(ended.traceId, ended);
      const trace = this.traces.get(ended.traceId);
      if (trace) this.onEvent?.({ type: "span.ended", trace, span: ended });
      return;
    }
    const span = await this.findSpan(spanId);
    if (!span) return;
    const endedAt = this.now();
    await this.store.updateSpan(span.traceId, spanId, {
      status: "completed",
      endedAt,
      durationMs: calculateDurationMs(span.startedAt, endedAt),
      output
    });
    const trace = await this.store.get(span.traceId);
    if (trace) this.onEvent?.({
      type: "span.ended",
      trace,
      span: { ...span, status: "completed", endedAt, durationMs: calculateDurationMs(span.startedAt, endedAt), output }
    });
  }

  async failSpan(spanId: string, error: unknown): Promise<void> {
    const cached = this.spans.get(spanId);
    if (cached) {
      const endedAt = this.now();
      const failed: LumeTraceSpan = {
        ...cached,
        status: "failed",
        endedAt,
        durationMs: calculateDurationMs(cached.startedAt, endedAt),
        error: normalizeError(error)
      };
      this.spans.set(spanId, failed);
      await this.store.appendSpan(failed.traceId, failed);
      const trace = this.traces.get(failed.traceId);
      if (trace) this.onEvent?.({ type: "span.ended", trace, span: failed });
      return;
    }
    const span = await this.findSpan(spanId);
    if (!span) return;
    const endedAt = this.now();
    await this.store.updateSpan(span.traceId, spanId, {
      status: "failed",
      endedAt,
      durationMs: calculateDurationMs(span.startedAt, endedAt),
      error: normalizeError(error)
    });
    const trace = await this.store.get(span.traceId);
    if (trace) this.onEvent?.({
      type: "span.ended",
      trace,
      span: {
        ...span,
        status: "failed",
        endedAt,
        durationMs: calculateDurationMs(span.startedAt, endedAt),
        error: normalizeError(error)
      }
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
    const cached = this.spans.get(spanId);
    if (cached) return cached;
    // 外部 span（非本 recorder 启动）：扫描 session store，保持旧路径
    // (#584:探测门与使用面曾错位——查 listByThread 干 tracesDir 的活,
    // 无 listByThread mock 但有 tracesDir 的实现被误判不支持)
    const knownTraces = await collectKnownTraces(this.store);
    for (const trace of knownTraces) {
      const span = trace.spans.find((item) => item.id === spanId);
      if (span) return span;
    }
    return null;
  }
}

async function collectKnownTraces(store: LumeTraceStore): Promise<LumeTrace[]> {
  if (!store.tracesDir) return [];
  const { readdirSync } = await import("node:fs");
  const traces: LumeTrace[] = [];
  for (const file of readdirSync(store.tracesDir)) {
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
