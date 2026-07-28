import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunContinuationState } from "./run-continuation";

export interface RunContinuationStore {
  upsert(state: RunContinuationState): Promise<void>;
  get(runId: string): Promise<RunContinuationState | null>;
  update(runId: string, patch: Partial<RunContinuationState>): Promise<void>;
}

class FileBackedRunContinuationStore implements RunContinuationStore {
  private readonly runsDir: string;

  constructor(sessionDir: string) {
    this.runsDir = join(sessionDir, "runs");
    mkdirSync(this.runsDir, { recursive: true });
  }

  async upsert(state: RunContinuationState): Promise<void> {
    writeTextAtomic(this.pathFor(state.runId), JSON.stringify(state, null, 2));
  }

  async get(runId: string): Promise<RunContinuationState | null> {
    const path = this.pathFor(runId);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as RunContinuationState;
    } catch {
      return null;
    }
  }

  async update(runId: string, patch: Partial<RunContinuationState>): Promise<void> {
    const current = await this.get(runId);
    if (!current) return;
    if (current.version === 1 && patch.status === "ready_to_execute") {
      await this.upsert({
        ...current,
        status: "not_resumable",
        reason: "历史 V1 checkpoint 不包含可验证的原工具输入，禁止推断并自动执行。",
        updatedAt: patch.updatedAt ?? new Date().toISOString()
      });
      return;
    }
    await this.upsert({
      ...current,
      ...patch,
      ...(patch.checkpoint ? {
        checkpoint: {
          ...current.checkpoint,
          ...patch.checkpoint
        }
      } : {}),
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    });
  }

  private pathFor(runId: string): string {
    return join(this.runsDir, `${runId}.continuation.json`);
  }
}

export function createFileBackedRunContinuationStore(sessionDir: string): RunContinuationStore {
  return new FileBackedRunContinuationStore(sessionDir);
}

function writeTextAtomic(path: string, payload: string): void {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}
