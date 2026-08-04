/**
 * Persona workflow-hook —— 监听 `run.afterComplete`，fire-and-forget
 * 触发 `ensurePersona({workspaceSlug})`。
 *
 * 设计要点（与 core-suggestion-hooks 同构）：
 * - 与 `core.memory.completion` / `core.suggestion.completion` 监听同一事件
 *   （run.afterComplete），但走完全独立的 handler / contribution / service，互不影响。
 * - **fire-and-forget**：handler 立即返回空 effects，persona 合成在后台进行。
 *   persona 合成绝不阻塞 run 完成路径——这是 brief 的硬约束。
 * - **try/catch 兜底**：附加 `.catch()` 吞掉所有 rejection，绝不冒泡到 hook-bus
 *   的 try/catch（bus 虽然也会 catch，但我们不希望错误计数污染 run 的 errors）。
 *   service 层本身也是 fail-open（persona.ts ensurePersona try/catch），这里是双保险。
 * - workspaceSlug 直传：存在时合成 workspace 级 persona，缺失时 ensurePersona
 *   内部回退 global 作用域（persona.ts 的设计），与 suggestion hook 透传字段一致。
 */
import type { LumeWorkflowHookHandlerRegistry } from "./hook-events";

export function createCorePersonaHookHandlers(): LumeWorkflowHookHandlerRegistry {
  return {
    "core.persona.completion": async (event, context) => {
      if (event.event !== "run.afterComplete") {
        return { effects: [] };
      }

      // fire-and-forget：handler 不 await，立即返回；persona 合成在后台进行。
      // .catch() 兜底：persona 失败绝不冒泡到 hook-bus / run 完成路径。
      void context.services.persona
        .ensurePersona({
          workspaceSlug: event.workspaceSlug
        })
        .catch(() => {
          // swallow：见上文设计要点。ensurePersona 内部已 log warn，此处静默即可。
        });

      return { effects: [] };
    }
  };
}
