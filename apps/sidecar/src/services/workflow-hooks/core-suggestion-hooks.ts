/**
 * Proactive Suggestion workflow-hook —— 监听 `run.afterComplete`，fire-and-forget
 * 触发 `evaluateSessionSuggestions`。
 *
 * 设计要点：
 * - 与 `core.memory.completion` 监听同一事件（run.afterComplete），但走完全独立的
 *   handler / contribution / service，互不影响。
 * - **fire-and-forget**：handler 立即返回空 effects，建议评估在后台进行。建议评估
 *   绝不阻塞 run 完成路径——这是 brief 的硬约束。
 * - **try/catch 兜底**：附加 `.catch()` 吞掉所有 rejection，绝不冒泡到 hook-bus
 *   的 try/catch（bus 虽然也会 catch，但我们不希望错误计数污染 run 的 errors）。
 *   service 层本身也是 fail-open（service.ts:98 try/catch），这里是双保险。
 * - sessionId：`run.afterComplete` payload 不携带 sessionId（见 hook-events.ts:56-71
 *   的 LumeWorkflowRunAfterCompleteEvent 字段），按 brief 指示回退 threadId
 *   （与 service 内 pickSessionKey 的回退逻辑一致，service.ts:280）。
 */
import type { LumeWorkflowHookHandlerRegistry } from "./hook-events";

export function createCoreSuggestionHookHandlers(): LumeWorkflowHookHandlerRegistry {
  return {
    "core.suggestion.completion": async (event, context) => {
      if (event.event !== "run.afterComplete") {
        return { effects: [] };
      }

      const metadata = event.messageMetadata;
      if (
        typeof metadata?.automationJobId === "string"
        || typeof metadata?.automationTrigger === "string"
      ) {
        return { effects: [] };
      }

      // fire-and-forget：handler 不 await，立即返回；评估在后台进行。
      // .catch() 兜底：建议失败绝不冒泡到 hook-bus / run 完成路径。
      void context.services.suggestion
        .evaluateSessionSuggestions({
          threadId: event.threadId,
          workspaceSlug: event.workspaceSlug,
          // payload 无 sessionId（hook-events.ts:56-71），回退 threadId
          sessionId: event.threadId
        })
        .catch(() => {
          // swallow：见上文设计要点。service.ts:98 已 log warn，此处静默即可。
        });

      return { effects: [] };
    }
  };
}
