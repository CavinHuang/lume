import type { RunContinuationState } from "../runner/run-continuation";
import type { RunContinuationStore } from "../runner/run-continuation-store";
import type { LumeRunStateStore } from "../runner/run-state-store";

export interface ResumeRunInput {
  runId: string;
  interruptionId?: string;
}

export interface ResumeRunResult {
  status: "resumed" | "waiting_for_approval" | "waiting_for_user" | "not_resumable" | "failed";
  finalOutput?: string;
  error?: string;
}

export type ContinueRunFromCheckpoint = (checkpoint: RunContinuationState) => Promise<{
  finalOutput?: string;
}>;

export class LumeResumeService {
  constructor(
    private readonly stores?: {
      runStateStore: LumeRunStateStore;
      continuationStore: RunContinuationStore;
    },
    private readonly continueRunFromCheckpoint?: ContinueRunFromCheckpoint
  ) {}

  async resumeRun(input: ResumeRunInput): Promise<ResumeRunResult> {
    if (!this.stores) {
      return {
        status: "not_resumable",
        error: "resume service 未配置 run state store 和 continuation store。"
      };
    }

    const state = await this.stores.runStateStore.get(input.runId);
    if (!state) {
      return {
        status: "not_resumable",
        error: "找不到 run state。"
      };
    }

    const pending = state.pendingInterruptions.filter((item) => item.status === "pending");
    if (pending.length > 0) {
      return {
        status: pending.some((item) => item.type === "ask_user") ? "waiting_for_user" : "waiting_for_approval"
      };
    }

    const continuation = await this.stores.continuationStore.get(input.runId);
    if (!continuation) {
      return {
        status: "not_resumable",
        error: "找不到可恢复 turn checkpoint。"
      };
    }

    if (continuation.status === "tool_running" || continuation.checkpoint.toolKind === "execute") {
      await this.stores.continuationStore.update(input.runId, {
        status: "not_resumable",
        reason: "正在执行或已中断的执行型工具不可冷启动恢复。"
      });
      return {
        status: "not_resumable",
        error: "正在执行或已中断的执行型工具不可冷启动恢复。"
      };
    }

    if (continuation.status !== "ready_to_resume") {
      return {
        status: "not_resumable",
        error: continuation.reason ?? "当前 checkpoint 不可恢复。"
      };
    }

    if (!this.continueRunFromCheckpoint) {
      return {
        status: "not_resumable",
        error: "没有注册 cold-start continuation runner。"
      };
    }

    try {
      const result = await this.continueRunFromCheckpoint(continuation);
      await this.stores.continuationStore.update(input.runId, {
        status: "resumed"
      });
      return {
        status: "resumed",
        finalOutput: result.finalOutput
      };
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async resumeRunWithoutCheckpoint(): Promise<ResumeRunResult> {
    return {
      status: "not_resumable",
      error: "完整 cold-start resume 需要 RunContinuationState；当前 run 没有 checkpoint。"
    };
  }
}
