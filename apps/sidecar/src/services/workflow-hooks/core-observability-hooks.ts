import type { LumeWorkflowHookHandlerRegistry } from "./hook-events";

export function createCoreObservabilityHookHandlers(): LumeWorkflowHookHandlerRegistry {
  return {
    "core.observability.trace": async (event, context) => {
      if (event.event !== "context.afterAssemble") {
        return { effects: [] };
      }
      return {
        effects: [{
          type: "recordTrace",
          record: context.services.trace.buildHookTrace({
            contributionId: "core.observability.trace",
            event: event.event,
            status: "success",
            effectTypes: ["recordTrace"]
          })
        }]
      };
    }
  };
}
