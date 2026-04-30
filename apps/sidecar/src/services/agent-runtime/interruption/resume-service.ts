import type { RunContinuationState } from "../runner/run-continuation";
import type { LumeRunState } from "../runner/run-state";
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

export type ContinueRunFromCheckpoint = (checkpoint: RunContinuationState, state: LumeRunState) => Promise<{
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

    if (
      continuation.status === "tool_running"
      || (
        continuation.checkpoint.step === "waiting_for_tool_result"
        && continuation.checkpoint.toolKind === "execute"
      )
    ) {
      await this.stores.continuationStore.update(input.runId, {
        status: "not_resumable",
        reason: "正在执行或已中断的执行型工具不可冷启动恢复。"
      });
      return {
        status: "not_resumable",
        error: "正在执行或已中断的执行型工具不可冷启动恢复。"
      };
    }

    if (continuation.checkpoint.step === "before_model_call") {
      await this.stores.continuationStore.update(input.runId, {
        status: "not_resumable",
        reason: "工具审批 checkpoint 不支持冷启动恢复；审批只用于唤醒当前 live resolver。"
      });
      return {
        status: "not_resumable",
        error: "工具审批 checkpoint 不支持冷启动恢复；审批只用于唤醒当前 live resolver。"
      };
    }

    if (continuation.status !== "ready_to_resume") {
      return {
        status: "not_resumable",
        error: continuation.reason ?? "当前 checkpoint 不可恢复。"
      };
    }

    if (
      continuation.checkpoint.step === "waiting_for_tool_result"
      && continuation.checkpoint.syntheticToolResult === undefined
    ) {
      await this.stores.continuationStore.update(input.runId, {
        status: "not_resumable",
        reason: "checkpoint 缺少可注入的工具结果，不能冷启动恢复。"
      });
      return {
        status: "not_resumable",
        error: "checkpoint 缺少可注入的工具结果，不能冷启动恢复。"
      };
    }

    if (!this.continueRunFromCheckpoint) {
      return {
        status: "not_resumable",
        error: "没有注册 cold-start continuation runner。"
      };
    }

    try {
      const result = await this.continueRunFromCheckpoint(continuation, state);
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

export function buildColdStartContinuationMessage(checkpoint: RunContinuationState): string {
  const toolName = checkpoint.checkpoint.toolName ?? "unknown tool";
  const result = checkpoint.checkpoint.syntheticToolResult;
  return [
    "继续执行之前因人工交互暂停的任务。",
    `恢复点: ${checkpoint.checkpoint.step}`,
    `工具: ${toolName}`,
    checkpoint.checkpoint.toolCallId ? `工具调用 ID: ${checkpoint.checkpoint.toolCallId}` : "",
    "已解决的交互结果:",
    stringifyContinuationResult(result),
    checkpoint.checkpoint.step === "before_model_call"
      ? "注意：如果这是工具审批结果，原工具调用尚未在冷启动恢复路径中执行；如仍需要该动作，请重新发起工具调用或调整计划。"
      : "",
    "请基于以上结果继续完成原始用户任务，不要声称恢复了不可恢复的进程内工具执行。"
  ].filter(Boolean).join("\n");
}

function stringifyContinuationResult(value: unknown): string {
  if (value === undefined) return "(无结构化结果)";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
