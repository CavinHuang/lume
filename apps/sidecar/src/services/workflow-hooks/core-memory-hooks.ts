import type { LumeWorkflowHookHandlerRegistry } from "./hook-events";

export function createCoreMemoryHookHandlers(): LumeWorkflowHookHandlerRegistry {
  return {
    "core.memory.context": async (event, context) => {
      if (event.event !== "context.beforeAssemble" || !event.workspaceSlug || !event.userMessage.trim()) {
        return { effects: [] };
      }
      const recalled = await context.services.memory.recallContext({
        threadId: event.threadId,
        workspaceSlug: event.workspaceSlug,
        userMessage: event.userMessage,
        tokenBudget: event.tokenBudget
      });
      if (!recalled.prefix) return { effects: [] };
      return {
        effects: [{
          type: "appendContext",
          source: "hook:core-memory-recall",
          content: recalled.prefix,
          hidden: true,
          usedMemoryItems: recalled.items,
          userMessageForModel: recalled.userMessageForModel
        }]
      };
    },
    "core.memory.completion": async (event, context) => {
      if (event.event !== "run.afterComplete" || !event.userMessage.trim()) {
        return { effects: [] };
      }
      const candidates = await context.services.memory.extractCandidates({
        runId: event.runId,
        threadId: event.threadId,
        workspaceSlug: event.workspaceSlug,
        userMessage: event.userMessage
      });
      return candidates.length > 0
        ? { effects: [{ type: "enqueueMemoryCandidate", candidates }] }
        : { effects: [] };
    }
  };
}
