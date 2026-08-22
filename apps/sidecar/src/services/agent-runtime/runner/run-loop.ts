import { projectLifecycle, type PermissionMode } from "@lume/agent-sdk";
import type { SdkLifecycleDetail, SDKMessage, SdkLifecycleEvent, TodoStateDetail } from "@lume/shared";
import {
  appendSdkMessage,
  createAgentStreamAccumulatorState,
  hasRenderableAssistantOutput
} from "../../agent/agent-stream-accumulator";
import { createLogger } from "../../infra/logger";
import { getThreadEventBus } from "../events/thread-event-bus";
import { publishRunDomainEvent } from "../events/bus-bridge";
import type { AgentRuntimeEmitter } from "./types";
import type { LumeRunObserver } from "./run-observer";

const log = createLogger("run-loop");

interface ConsumeRuntimeCoreQueryStreamInput {
  query: AsyncIterable<SDKMessage>;
  emit: Pick<AgentRuntimeEmitter, "onSdkMessage">;
  /** 投影 lifecycle 事件到 ThreadEventBus(批次5 T7c 起恒开,flag 已退役)。
   * runId=Lume runId(lume-runner 构造处 observer.getRunId())——骨架事件弃自产
   * UUID,与第二入口领域事件(memory/todo/advisor)同域(批次5 Task 6)。
   * onRunEnd(F3):projector 产出 run.end 终值时回调——LumeRunner 据此在异常
   * 路径跳过终值补发,保证同一 run 只有一个总线终值。 */
  lifecycle?: { threadId: string; sessionDir: string; runId: string; onRunEnd?: () => void };
  /** Live 注入通道(#285):SDK 工具执行期直通的事件(task_progress 等)绕过
   * 主流 generator,经此入口进入同一条投影链——projectLifecycle 单源折叠、
   * 总线 update 相位照常持久折叠。注册时机:消费开始前由本函数回调一次,
   * 传入 inject;主流结束后注入自动失效(投影泵已排空退出)。 */
  onLiveInject?: (inject: (message: SDKMessage) => void) => void;
}

/**
 * Tee 主 query 流：每个 chunk 照常转发给主循环，同时排入队列由后台泵
 * 喂给 projectLifecycle，产物 fire-and-forget publish 到线程事件总线
 * （失败仅 warn，不阻塞也不影响主流）。主流提前 return（错误 result）时
 * 由 finally 结束队列并等泵排空，保证事件序列完整落盘。
 */
async function* teeLifecycleProjection(
  query: AsyncIterable<SDKMessage>,
  target: { threadId: string; sessionDir: string; runId: string; onRunEnd?: () => void },
  onLiveInjectReady?: (inject: (message: SDKMessage) => void) => void
): AsyncGenerator<SDKMessage> {
  const bus = getThreadEventBus(target.sessionDir);
  const pending: SDKMessage[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  // F3:主流异常先记录再 rethrow——finally 排空 pump 时投影链取到异常,
  // projector 据此补发 run.end{error} 而非把错误流当正常结束标 aborted。
  let streamFailed = false;
  let streamError: unknown = null;
  const projected: AsyncIterable<SDKMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<SDKMessage>> => {
        while (pending.length === 0) {
          if (finished) {
            if (streamFailed) throw streamError;
            return { done: true, value: undefined };
          }
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
  // Live 注入(#285):工具执行期直通事件与主流共用同一条投影链——projectLifecycle
  // 单源折叠、总线 update 相位照常持久折叠。run 结束后迟到的进度事件直接丢弃
  // (投影泵已排空,无消费者)。
  onLiveInjectReady?.((message) => {
    if (finished) return;
    pending.push(message);
    notifyProjected();
  });
  const pump = (async () => {
    try {
      for await (const event of projectLifecycle(projected, { runId: target.runId })) {
        // F3 互斥标记:见到 run.end 即通知调用方终值已由投影链交付
        if (event.kind === "run" && event.phase === "end") target.onRunEnd?.();
        // 前提钉死(#257 后语义):bus.publish 对非 update 相位同步落盘后 resolve;对 update
        // 相位 resolve 即已入持久折叠缓冲(≤500ms 窗口,且任何非 update 相位先冲盘)。投影链
        // 终点必发 run.end(非 update),tee finally 的 await pump 排空即 run 边界全部落盘。
        // 若改为真异步 fs,fire-and-forget 的 publish 会让 await pump 不再等落盘——改前必须
        // 同步改造 tee(pump 内 await publish)。
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
  } catch (error) {
    // F3 fix round 1:abort 味异常(用户主动取消)不注入投影链——与 LumeRunner
    // catch 的 /abort|interrupted/i 判定对齐,post-loop 保持 aborted 终值语义,
    // 避免总线 error 与 observer cancelled 分裂(用户取消显示为 run.failed)。
    if (!/abort|interrupted/i.test(error instanceof Error ? error.message : String(error))) {
      streamFailed = true;
      streamError = error;
    }
    throw error;
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
  lifecycle,
  onLiveInject
}: ConsumeRuntimeCoreQueryStreamInput) {
  const accumulator = createAgentStreamAccumulatorState();
  const source = lifecycle
    ? teeLifecycleProjection(query, lifecycle, onLiveInject)
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
      // #392:SDK 内部 repeat guard 硬停（error_completion_guard + errorCode
      // repeated_tool_call）映射为带标记的 turn_limited 而非泛化 errored——
      // 进度照 turn_limit 语义持久化，下条消息可注入恢复上下文；宿主自有
      // completionGuard stop（无 errorCode）保持 errored 不变。
      if (message.subtype === "error_completion_guard" && message.errorCode === "repeated_tool_call") {
        return {
          status: "turn_limited" as const,
          errorMessage: errorMessage || "Agent 因重复执行相同操作被保护机制停止。",
          terminationReason: "repeat_guard" as const
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
      // 批次5 第二入口:同一 todo state 经 ThreadEventBus 发布(run 级领域事件,
      // T7c 起恒开);T7a 后旧路投影已删,item 记录仅供 hydrate replay。
      // runId 取 Lume run id,detail.state 与回调载荷同引用。
      if (bus) {
        const detail: TodoStateDetail = { type: "todo.state", state };
        publishRunDomainEvent({
          sessionDir: bus.sessionDir,
          threadId: observer.getThreadId(),
          runId: observer.getRunId(),
          label: "todo.state",
          detail
        });
      }
    },
    onToolPermissionRequest: (request) => {
      void observer.flush();
      emit.onToolPermissionRequest(request);
    }
  };
}
