import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import type { LumeTrace, LumeTraceSpan } from "./trace-types";

export interface LumeTraceStore {
  create(trace: LumeTrace): Promise<void>;
  get(traceId: string): Promise<LumeTrace | null>;
  update(traceId: string, patch: Partial<LumeTrace>): Promise<void>;
  appendSpan(traceId: string, span: LumeTraceSpan): Promise<void>;
  updateSpan(traceId: string, spanId: string, patch: Partial<LumeTraceSpan>): Promise<void>;
  listByThread(threadId: string): Promise<LumeTrace[]>;
  /** 文件后端的 trace 目录(#584 显式可选声明);内存/测试实现可不提供。 */
  tracesDir?: string;
}

function writeTextAtomic(path: string, payload: string): void {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

function readTrace(path: string): LumeTrace | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as LumeTrace;
  } catch {
    return null;
  }
}

function readJsonlFile<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return null;
      }
    })
    .filter((item): item is T => item !== null);
}

/**
 * 读取 spans.jsonl 并按 spanId 去重，取每个 span 的最后版本（event-sourcing）。
 * Map 保持首次插入顺序 = appendSpan(startSpan) 顺序，updateSpan 追加的新版本只更新值不改顺序。
 */
function readSpans(path: string): LumeTraceSpan[] {
  const records = readJsonlFile<LumeTraceSpan>(path);
  const byId = new Map<string, LumeTraceSpan>();
  for (const span of records) {
    byId.set(span.id, span);
  }
  return [...byId.values()];
}

class FileBackedLumeTraceStore implements LumeTraceStore {
  readonly tracesDir: string;

  constructor(sessionDir: string) {
    this.tracesDir = join(sessionDir, "traces");
    mkdirSync(this.tracesDir, { recursive: true });
  }

  async create(trace: LumeTrace): Promise<void> {
    writeTextAtomic(this.tracePath(trace.id), JSON.stringify({ ...trace, spans: [] }, null, 2));
    if (trace.spans.length > 0) {
      writeTextAtomic(
        this.spansPath(trace.id),
        trace.spans.map((span) => JSON.stringify(span)).join("\n") + "\n"
      );
    }
  }

  async get(traceId: string): Promise<LumeTrace | null> {
    const trace = readTrace(this.tracePath(traceId));
    if (!trace) return null;
    return { ...trace, spans: readSpans(this.spansPath(traceId)) };
  }

  async update(traceId: string, patch: Partial<LumeTrace>): Promise<void> {
    const trace = readTrace(this.tracePath(traceId));
    if (!trace) return;
    writeTextAtomic(this.tracePath(traceId), JSON.stringify({ ...trace, ...patch }, null, 2));
  }

  async appendSpan(traceId: string, span: LumeTraceSpan): Promise<void> {
    if (!existsSync(this.tracePath(traceId))) return;
    appendFileSync(this.spansPath(traceId), JSON.stringify(span) + "\n", "utf-8");
  }

  async updateSpan(traceId: string, spanId: string, patch: Partial<LumeTraceSpan>): Promise<void> {
    const spans = readSpans(this.spansPath(traceId));
    const current = spans.find((span) => span.id === spanId);
    if (!current) return;
    const next: LumeTraceSpan = { ...current, ...patch };
    appendFileSync(this.spansPath(traceId), JSON.stringify(next) + "\n", "utf-8");
  }

  async listByThread(threadId: string): Promise<LumeTrace[]> {
    if (!existsSync(this.tracesDir)) return [];
    const traces: LumeTrace[] = [];
    for (const file of readdirSync(this.tracesDir)) {
      if (!file.endsWith(".json")) continue;
      const traceId = file.slice(0, -".json".length);
      const trace = await this.get(traceId);
      if (trace?.threadId === threadId) {
        traces.push(trace);
      }
    }
    return traces.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  private tracePath(traceId: string): string {
    return join(this.tracesDir, `${traceId}.json`);
  }

  private spansPath(traceId: string): string {
    return join(this.tracesDir, `${traceId}.spans.jsonl`);
  }
}

export function createFileBackedLumeTraceStore(sessionDir: string): LumeTraceStore {
  return new FileBackedLumeTraceStore(sessionDir);
}
