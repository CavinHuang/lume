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
    // #650：单槽互覆防护——已有主槽属于另一个后台任务时，把它降级进
    // backgroundCheckpoints 数组而不是直接覆盖。
    // 预读必须保持同步：既有消费方依赖 "fire-and-forget upsert 返回后立即可
    // 读" 的时序（persistToolApprovalInterruption 不被 await），引入 await 会
    // 让出事件循环导致紧随其后的 get 读到空。
    const existing = this.getInternalSync(state.runId);
    const merged = mergeBackgroundCheckpoints(existing, state);
    writeTextAtomic(this.pathFor(state.runId), JSON.stringify(merged, null, 2));
  }

  async get(runId: string): Promise<RunContinuationState | null> {
    return this.getInternalSync(runId);
  }

  private getInternalSync(runId: string): RunContinuationState | null {
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

/**
 * #650：单槽互覆防护——新 checkpoint 属于不同 processJobId 时，把已有主槽
 * （连同其数组中除新任务外的项）并入 backgroundCheckpoints 保留，而不是覆盖。
 */
function mergeBackgroundCheckpoints(
  existing: RunContinuationState | null,
  incoming: RunContinuationState,
): RunContinuationState {
  if (
    !existing ||
    existing.version !== 2 ||
    !existing.checkpoint.processJobId ||
    existing.checkpoint.processJobId === incoming.checkpoint.processJobId
  ) {
    return incoming;
  }
  const priorProcessJobId: string = existing.checkpoint.processJobId;
  const prior = existing.checkpoint;
  // 走到这里时 prior.processJobId 已确认非空（上方守卫）
  const carried = (incoming.backgroundCheckpoints ?? []).filter(
    (item) => item.processJobId !== prior.processJobId && item.processJobId !== incoming.checkpoint.processJobId,
  );
  const demoted: NonNullable<RunContinuationState["backgroundCheckpoints"]>[number] = {
    processJobId: priorProcessJobId,
    toolCallId: prior.toolCallId ?? "",
    toolName: prior.toolName ?? "",
    toolKind: (prior.toolKind ?? "execute") as NonNullable<RunContinuationState["backgroundCheckpoints"]>[number]["toolKind"],
    toolCall: prior.toolCall ?? {
      id: prior.toolCallId ?? "",
      name: prior.toolName ?? "",
      input: null,
      inputHash: "",
      kind: "execute" as const,
    },
    syntheticToolResult: prior.syntheticToolResult,
    updatedAt: existing.updatedAt,
  };
  const deduped = carried.filter((item) => item.processJobId !== demoted.processJobId);
  return { ...incoming, backgroundCheckpoints: [...deduped, demoted] };
}
