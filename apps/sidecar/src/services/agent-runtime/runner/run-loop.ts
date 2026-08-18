import { projectLifecycle, type PermissionMode } from "@lume/agent-sdk";
import type { SdkLifecycleDetail, SDKMessage, SdkLifecycleEvent, TodoStateDetail } from "@lume/shared";
import {
  appendSdkMessage,
  createAgentStreamAccumulatorState,
  hasRenderableAssistantOutput
} from "../../agent/agent-stream-accumulator";
import { createLogger } from "../../infra/logger";
import { getThreadEventBus } from "../events/thread-event-bus";
import type { AgentRuntimeEmitter } from "./types";
import type { LumeRunObserver } from "./run-observer";

const log = createLogger("run-loop");

interface ConsumeRuntimeCoreQueryStreamInput {
  query: AsyncIterable<SDKMessage>;
  emit: Pick<AgentRuntimeEmitter, "onSdkMessage">;
  /** AGENT_LIFECYCLE_EVENTS=1 时投影 lifecycle 事件到 ThreadEventBus；缺省不启用。
   * runId=Lume runId(lume-runner 构造处 observer.getRunId())——骨架事件弃自产
   * UUID,与第二入口领域事件(memory/todo/advisor)同域(批次5 Task 6)。 */
  lifecycle?: { threadId: string; sessionDir: string; runId: string };
}

/** Batch 1 feature flag：默认 off，显式置 1 才接入 lifecycle 投影。 */
export function isAgentLifecycleEventsEnabled(): boolean {
  return process.env.AGENT_LIFECYCLE_EVENTS === "1";
}

/**
 * Tee 主 query 流：每个 chunk 照常转发给主循环，同时排入队列由后台泵
 * 喂给 projectLifecycle，产物 fire-and-forget publish 到线程事件总线
 * （失败仅 warn，不阻塞也不影响主流）。主流提前 return（错误 result）时
 * 由 finally 结束队列并等泵排空，保证事件序列完整落盘。
 */
async function* teeLifecycleProjection(
  query: AsyncIterable<SDKMessage>,
  target: { threadId: string; sessionDir: string; runId: string }
): AsyncGenerator<SDKMessage> {
  const bus = getThreadEventBus(target.sessionDir);
  const pending: SDKMessage[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  const projected: AsyncIterable<SDKMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<SDKMessage>> => {
        while (pending.length === 0) {
          if (finished) return { done: true, value: undefined };
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        return { done: false, value: pending.shift()! };
      }
    })
  };
  // 独立成函数：闭包内读取 wake 才不会被外层 null 赋值的窄化污染
  const notifyProjected = (): void => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  const pump = (async () => {
    try {
      for await (const event of projectLifecycle(projected, { runId: target.runId })) {
        // 前提钉死:bus.publish 当前全同步(appendFileSync 后 resolve),resolve 即持久化完成。
        // 若改为真异步 fs,promise 化的 publish 在此 fire-and-forget 会让 finally 的 await pump
        // 不再等事件落盘——run 尾事件将静默丢失;重构前必须同步改造 tee(pump 内 await publish)。
        // 用 .catch 而非同步 try/catch:后者对异步 reject 无效,.catch 兼容两种时序。
        void bus.publish(target.threadId, (event as SdkLifecycleEvent<SdkLifecycleDetail>).runId, event)
          .catch((error) => {
            log.warn("lifecycle 事件 publish 失败", {
              threadId: target.threadId,
              error: error instanceof Error ? error.message : String(error)
            });
          });
      }
    } catch (error) {
      log.warn("lifecycle 投影失败", {
        threadId: target.threadId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  })();
  try {
    for await (const message of query) {
      pending.push(message);
      notifyProjected();
      yield message;
    }
  } finally {
    finished = true;
    notifyProjected();
    await pump;
  }
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
  emit,
  lifecycle
}: ConsumeRuntimeCoreQueryStreamInput) {
  const accumulator = createAgentStreamAccumulatorState();
  const source = lifecycle && isAgentLifecycleEventsEnabled()
    ? teeLifecycleProjection(query, lifecycle)
    : query;

  for await (const message of source) {
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
  observer: LumeRunObserver,
  bus?: { sessionDir: string }
): AgentRuntimeEmitter {
  return {
    ...emit,
    onRuntimeEvent: (event) => emit.onRuntimeEvent?.({
      ...event,
      fileReferenceBinding: observer.getFileReferenceBinding()
    }),
    onSdkMessage: (message) => {
      observer.recordSdkMessage(message, emit.onRuntimeEvent);
      emit.onSdkMessage(message);
    },
    onTodoUpdated: (state) => {
      observer.recordTodoState(state);
      emit.onTodoUpdated?.(state);
      // 批次5 第二入口:flag on 时同一 todo state 经 ThreadEventBus 发布(run 级
      // 领域事件);T7a 后旧路投影已删,item 记录仅供 hydrate replay。
      // runId 取 Lume run id,detail.state 与回调载荷同引用。
      if (bus && isAgentLifecycleEventsEnabled()) {
        const threadId = observer.getThreadId();
        const runId = observer.getRunId();
        const detail: TodoStateDetail = { type: "todo.state", state };
        void getThreadEventBus(bus.sessionDir)
          .publish(threadId, runId, {
            runId,
            turnId: null,
            ts: Date.now(),
            kind: "run",
            phase: "event",
            detail
          })
          .catch((error) => {
            log.warn("todo.state 总线 publish 失败", {
              threadId,
              error: error instanceof Error ? error.message : String(error)
            });
          });
      }
    },
    onToolPermissionRequest: (request) => {
      void observer.flush();
      emit.onToolPermissionRequest(request);
    }
  };
}
