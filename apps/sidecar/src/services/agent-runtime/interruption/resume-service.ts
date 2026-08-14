import type { RunContinuationState } from "../runner/run-continuation";
import type { LumeRunState } from "../runner/run-state";
import type { RunContinuationStore } from "../runner/run-continuation-store";
import type { LumeRunStateStore } from "../runner/run-state-store";

export interface ResumeRunInput {
  runId: string;
  interruptionId?: string;
}

export interface ResumeRunResult {
  status: "resumed" | "waiting_for_approval" | "waiting_for_user" | "waiting_background" | "not_resumable" | "failed";
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

    if (continuation.version === 1 && (
      continuation.status === "tool_running"
      || (
        continuation.checkpoint.step === "waiting_for_tool_result"
        && continuation.checkpoint.toolKind === "execute"
      )
    )) {
      await this.stores.continuationStore.update(input.runId, {
        status: "not_resumable",
        reason: "正在执行或已中断的执行型工具不可冷启动恢复。"
      });
      return {
        status: "not_resumable",
        error: "正在执行或已中断的执行型工具不可冷启动恢复。"
      };
    }

    if (continuation.version === 1 && continuation.checkpoint.step === "before_model_call") {
      await this.stores.continuationStore.update(input.runId, {
        status: "not_resumable",
        reason: "工具审批 checkpoint 不支持冷启动恢复；审批只用于唤醒当前 live resolver。"
      });
      return {
        status: "not_resumable",
        error: "工具审批 checkpoint 不支持冷启动恢复；审批只用于唤醒当前 live resolver。"
      };
    }

    if (continuation.version === 2 && continuation.status === "waiting_background") {
      if (continuation.checkpoint.syntheticToolResult === undefined) {
        return {
          status: "waiting_background",
          error: continuation.reason ?? "后台任务仍在运行，已重新附着且不会重复执行命令。"
        };
      }
      await this.stores.continuationStore.update(input.runId, { status: "ready_to_resume" });
      continuation.status = "ready_to_resume";
    }

    if (
      continuation.version === 2
      && continuation.status === "tool_running"
      && continuation.checkpoint.syntheticToolResult === undefined
    ) {
      if (continuation.checkpoint.processJobId) {
        await this.stores.continuationStore.update(input.runId, {
          status: "waiting_background",
          reason: "后台任务已重新附着，等待持久化终态结果。"
        });
        return { status: "waiting_background" };
      }
      if (continuation.checkpoint.toolKind === "read" && continuation.checkpoint.toolCall) {
        await this.stores.continuationStore.update(input.runId, {
          status: "ready_to_execute",
          checkpoint: { ...continuation.checkpoint, step: "before_tool_execution" },
          reason: "只读工具结果未知，允许使用相同输入安全重放。"
        });
        continuation.status = "ready_to_execute";
        continuation.checkpoint.step = "before_tool_execution";
      } else {
        await this.stores.continuationStore.update(input.runId, {
          status: "interrupted",
          reason: "副作用工具执行结果未知，禁止自动重放；Agent 必须先读取实际状态。"
        });
        return {
          status: "not_resumable",
          error: "interrupted_unknown：副作用工具执行结果未知，已阻止自动重放。"
        };
      }
    }

    // 人工中止（Task 6 abort checkpoint）留下的 interrupted 状态：
    // 只读/控制工具结果未知，允许相同输入安全重放；副作用工具结果未知，
    // 注入中断说明占位（不自动重放），交由 Agent 检查实际状态后决定重试。
    if (continuation.version === 2 && continuation.status === "interrupted") {
      const checkpoint = continuation.checkpoint;
      if (
        checkpoint.step === "waiting_for_tool_result"
        && checkpoint.toolCall
        && (checkpoint.toolKind === "read" || checkpoint.toolKind === "control")
      ) {
        const nextCheckpoint = { ...checkpoint, step: "before_tool_execution" as const };
        await this.stores.continuationStore.update(input.runId, {
          status: "ready_to_execute",
          checkpoint: nextCheckpoint,
          reason: "中断的只读/控制工具结果未知，允许使用相同输入安全重放。"
        });
        continuation.status = "ready_to_execute";
        continuation.checkpoint = nextCheckpoint;
      } else if (checkpoint.step === "waiting_for_tool_result" && checkpoint.toolCall) {
        const nextCheckpoint = {
          ...checkpoint,
          syntheticToolResult: {
            type: "tool_result" as const,
            tool_use_id: checkpoint.toolCall.id,
            content: "工具执行被用户中断，实际结果未知；请先检查工作区实际状态再决定是否重试。",
            is_error: true
          }
        };
        await this.stores.continuationStore.update(input.runId, {
          status: "ready_to_resume",
          checkpoint: nextCheckpoint,
          reason: "中断的副作用工具结果未知；已注入中断说明占位，禁止自动重放。"
        });
        continuation.status = "ready_to_resume";
        continuation.checkpoint = nextCheckpoint;
      }
    }

    if (continuation.version === 2 && continuation.status === "ready_to_execute" && !continuation.checkpoint.toolCall) {
      await this.stores.continuationStore.update(input.runId, {
        status: "failed",
        reason: "V2 checkpoint 缺少原工具调用输入。"
      });
      return { status: "not_resumable", error: "V2 checkpoint 缺少原工具调用输入。" };
    }

    if (continuation.status !== "ready_to_resume" && continuation.status !== "ready_to_execute") {
      return {
        status: "not_resumable",
        error: continuation.reason ?? "当前 checkpoint 不可恢复。"
      };
    }

    if (
      continuation.status === "ready_to_resume"
      && continuation.checkpoint.step === "waiting_for_tool_result"
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
  const toolCall = checkpoint.checkpoint.toolCall;
  if (checkpoint.version === 2 && checkpoint.status === "ready_to_execute" && toolCall) {
    return [
      "继续执行之前因人工审批暂停的任务。",
      "恢复边界：原工具尚未执行。",
      `工具调用 ID: ${toolCall.id}`,
      `工具: ${toolCall.name}`,
      `输入哈希: ${toolCall.inputHash}`,
      "保存的原始输入:",
      stringifyContinuationResult(toolCall.input),
      "仅执行上述原工具调用一次；不要改写输入，不要先发起新的规划轮次。执行后读取实际结果并继续原始用户任务。"
    ].join("\n");
  }
  return [
    "继续执行之前因人工交互暂停的任务。",
    `恢复点: ${checkpoint.checkpoint.step}`,
    `工具: ${toolName}`,
    checkpoint.checkpoint.toolCallId ? `工具调用 ID: ${checkpoint.checkpoint.toolCallId}` : "",
    "已解决的交互结果:",
    stringifyContinuationResult(result),
    checkpoint.version === 1 && checkpoint.checkpoint.step === "before_model_call"
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
