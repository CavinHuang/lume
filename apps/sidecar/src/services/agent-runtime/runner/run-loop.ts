import type { PermissionMode } from "@lume/agent-sdk";
import type { SDKMessage } from "@lume/shared";
import {
  appendSdkMessage,
  createAgentStreamAccumulatorState,
  hasRenderableAssistantOutput
} from "../../agent/agent-stream-accumulator";
import type { AgentRuntimeEmitter } from "./types";
import type { LumeRunObserver } from "./run-observer";

interface ConsumeRuntimeCoreQueryStreamInput {
  query: AsyncIterable<SDKMessage>;
  emit: Pick<AgentRuntimeEmitter, "onSdkMessage">;
}

export function normalizeRuntimeCoreQueryPermissionMode(
  permissionMode: PermissionMode | undefined
): PermissionMode {
  if (
    permissionMode === "bypassPermissions"
    || permissionMode === "plan"
    || permissionMode === "acceptEdits"
    || permissionMode === "dontAsk"
  ) {
    return permissionMode;
  }
  return "default";
}

export async function consumeRuntimeCoreQueryStream({
  query,
  emit
}: ConsumeRuntimeCoreQueryStreamInput) {
  const accumulator = createAgentStreamAccumulatorState();

  for await (const message of query) {
    emit.onSdkMessage(message);
    appendSdkMessage(accumulator, message);

    const errorMessage = getRuntimeCoreStreamError(message);
    if (message.type === "result" && message.is_error) {
      if (message.subtype === "error_max_turns") {
        return {
          status: "turn_limited" as const,
          errorMessage: errorMessage || "Agent SDK 达到最大回合数，本轮需要继续执行。"
        };
      }
      return {
        status: "errored" as const,
        errorMessage: errorMessage || "Agent SDK 执行失败"
      };
    }
  }

  if (!hasRenderableAssistantOutput(accumulator)) {
    return {
      status: "errored" as const,
      errorMessage: "runtime-core 未检测到可渲染输出。"
    };
  }

  return { status: "completed" as const };
}

export function getRuntimeCoreStreamError(message: SDKMessage): string | null {
  if (message.type === "result" && message.is_error) {
    const firstError = Array.isArray(message.errors) ? message.errors[0] : undefined;
    const detailedResult = typeof message.result === "string" ? message.result.trim() : "";
    if (message.subtype === "error_max_turns") {
      const turns = typeof message.num_turns === "number" ? `（${message.num_turns}）` : "";
      return `Agent SDK 达到最大回合数${turns}，本轮需要继续执行。`;
    }
    return typeof firstError === "string" && firstError.trim()
      ? firstError
      : detailedResult || "Agent SDK 执行失败";
  }
  if (message.type === "assistant" && message.error) {
    const text = (message.message?.content ?? [])
      .filter((block) => !!block && typeof block === "object")
      .map((block) => block as { type?: string; text?: string })
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text ?? "")
      .join("")
      .trim();
    return text || message.error;
  }
  if (message.type === "system" && message.subtype === "status" && typeof message.message === "string") {
    return message.message;
  }
  return null;
}

export function createObservedRuntimeEmitter(
  emit: AgentRuntimeEmitter,
  observer: LumeRunObserver
): AgentRuntimeEmitter {
  return {
    ...emit,
    onSdkMessage: (message) => {
      observer.recordSdkMessage(message, emit.onRuntimeEvent);
      emit.onSdkMessage(message);
    },
    onTaskContractUpdated: (contract, preview) => {
      if (preview) {
        observer.recordPlanPreview(preview, emit.onRuntimeEvent);
      }
      emit.onTaskContractUpdated?.(contract, preview);
    },
    onTodoUpdated: (state) => {
      observer.recordTodoState(state, emit.onRuntimeEvent);
      emit.onTodoUpdated?.(state);
    }
  };
}
