import {
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

class FileBackedLumeTraceStore implements LumeTraceStore {
  private readonly tracesDir: string;

  constructor(sessionDir: string) {
    this.tracesDir = join(sessionDir, "traces");
    mkdirSync(this.tracesDir, { recursive: true });
  }

  async create(trace: LumeTrace): Promise<void> {
    writeTextAtomic(this.tracePath(trace.id), JSON.stringify(trace, null, 2));
  }

  async get(traceId: string): Promise<LumeTrace | null> {
    return readTrace(this.tracePath(traceId));
  }

  async update(traceId: string, patch: Partial<LumeTrace>): Promise<void> {
    const trace = await this.get(traceId);
    if (!trace) return;
    writeTextAtomic(this.tracePath(traceId), JSON.stringify({ ...trace, ...patch }, null, 2));
  }

  async appendSpan(traceId: string, span: LumeTraceSpan): Promise<void> {
    const trace = await this.get(traceId);
    if (!trace) return;
    await this.update(traceId, { spans: [...trace.spans, span] });
  }

  async updateSpan(traceId: string, spanId: string, patch: Partial<LumeTraceSpan>): Promise<void> {
    const trace = await this.get(traceId);
    if (!trace) return;
    await this.update(traceId, {
      spans: trace.spans.map((span) => span.id === spanId ? { ...span, ...patch } : span)
    });
  }

  async listByThread(threadId: string): Promise<LumeTrace[]> {
    if (!existsSync(this.tracesDir)) return [];
    const traces: LumeTrace[] = [];
    for (const file of readdirSync(this.tracesDir)) {
      if (!file.endsWith(".json")) continue;
      const trace = readTrace(join(this.tracesDir, file));
      if (trace?.threadId === threadId) {
        traces.push(trace);
      }
    }
    return traces.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  private tracePath(traceId: string): string {
    return join(this.tracesDir, `${traceId}.json`);
  }
}

export function createFileBackedLumeTraceStore(sessionDir: string): LumeTraceStore {
  return new FileBackedLumeTraceStore(sessionDir);
}
