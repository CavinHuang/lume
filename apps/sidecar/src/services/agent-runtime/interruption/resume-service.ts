import type { SDKMessage } from "@lume/shared";
import type { RunContinuationState } from "../runtime-core/run-continuation";
import type { LumeRunState } from "../runtime-core/run-state";
import type { RunContinuationStore } from "../runtime-core/run-continuation-store";
import type { LumeRunStateStore } from "../runtime-core/run-state-store";

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
      /**
       * 崩溃恢复(#411③):按 processJobId 取后台任务已持久化的终态通知
       * (background-process-recovery 服务在重启后落盘 transcript);
       * undefined = 尚无持久化终态(任务可能仍活着)。
       */
      resolveBackgroundNotification?: (processJobId: string) => Promise<SDKMessage | undefined>;
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
        // 崩溃后 live 终态监听(run.handleAsyncEvent)已不在:查 recovery 服务落盘的
        // 持久化终态通知,有则与 live 同形转换(ready_to_resume + syntheticToolResult),
        // 让恢复真正发生;无则任务可能仍活着(durable 跨重启),如实返回等待态。
        const notification = continuation.checkpoint.processJobId
          ? await this.stores.resolveBackgroundNotification?.(continuation.checkpoint.processJobId)
          : undefined;
        if (!notification || typeof notification !== "object") {
          return {
            status: "waiting_background",
            error: "后台任务尚未产生持久化终态；若任务仍在运行，终态落盘后再次恢复即可继续。"
          };
        }
        const record = notification as unknown as Record<string, unknown>;
        const synthetic = {
          type: "tool_result",
          tool_use_id:
            (typeof record.tool_use_id === "string" && record.tool_use_id)
            || continuation.checkpoint.toolCallId
            || "",
          content: record.message ?? record.summary ?? "",
          ...(record.status === "failed" || record.status === "stopped" || record.status === "interrupted"
            ? { is_error: true }
            : {}),
          ...(record.execution && typeof record.execution === "object"
            ? { _meta: { execution: record.execution } }
            : {}),
        };
        await this.stores.continuationStore.update(input.runId, {
          status: "ready_to_resume",
          checkpoint: { ...continuation.checkpoint, step: "after_tool_result", syntheticToolResult: synthetic },
          reason: "后台命令已进入终态（崩溃恢复）。"
        });
        continuation.status = "ready_to_resume";
        continuation.checkpoint = { ...continuation.checkpoint, step: "after_tool_result", syntheticToolResult: synthetic };
      } else {
        await this.stores.continuationStore.update(input.runId, { status: "ready_to_resume" });
        continuation.status = "ready_to_resume";
      }
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
    // 软中止时 SDK engine 已为每个被中断工具补 error 占位 tool_result 并随
    // message 级持久化落盘，历史配对已完整。这里若再重放或注入同 id 的
    // syntheticToolResult，会与历史占位产生重复 tool_result（provider 400）。
    // 因此不经工具注入路径，直接以"继续原始任务"消息续跑（与
    // dangling-fallback 纯消息路径同构），由消费方以不带 checkpoint 的
    // runtimeContinuation 发送续跑消息，让模型读取已有占位后自行决策。
    if (continuation.version === 2 && continuation.status === "interrupted") {
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
