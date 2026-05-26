import type { LumeWorkflowHookHandlerRegistry } from "./hook-events";

export function createCoreSecurityHookHandlers(): LumeWorkflowHookHandlerRegistry {
  return {
    "core.security.permission": async (event, context) => {
      if (event.event !== "permission.beforeDecision") {
        return { effects: [] };
      }
      const decision = await context.services.security.evaluatePermissionDecision({
        toolName: event.toolName,
        toolInputSummary: event.toolInputSummary,
        permissionMode: event.permissionMode,
        gatewayDecision: event.gatewayDecision,
        risk: event.risk,
        reasonCode: event.reasonCode
      });
      if (!decision.decision || !decision.reason) {
        return { effects: [] };
      }
      return {
        effects: [{
          type: "setPermissionDecision",
          decision: decision.decision,
          reason: decision.reason
        }]
      };
    }
  };
}
