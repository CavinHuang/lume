import type { LumeConfigHooksInternalSection } from "@lume/shared";
import type { LumeWorkflowHookContribution } from "./hook-events";

export function createCoreWorkflowHookContributions(
  config: LumeConfigHooksInternalSection
): LumeWorkflowHookContribution[] {
  if (config.enabled === false) return [];
  return [
    ...(config.memory === false ? [] : [
      {
        id: "core.memory.context",
        pluginId: "lume-core",
        event: "context.beforeAssemble",
        phase: "decision",
        priority: "core",
        capabilities: ["context.append"],
        handlerRef: "core.memory.context"
      },
      {
        id: "core.memory.completion",
        pluginId: "lume-core",
        event: "run.afterComplete",
        phase: "observe",
        priority: "core",
        capabilities: ["memory.enqueue"],
        handlerRef: "core.memory.completion"
      }
    ] satisfies LumeWorkflowHookContribution[]),
    ...(config.security === false ? [] : [
      {
        id: "core.security.permission",
        pluginId: "lume-core",
        event: "permission.beforeDecision",
        phase: "decision",
        priority: "core",
        capabilities: ["permission.decide"],
        handlerRef: "core.security.permission"
      }
    ] satisfies LumeWorkflowHookContribution[]),
    ...(config.observability === false ? [] : [
      {
        id: "core.observability.trace",
        pluginId: "lume-core",
        event: "context.afterAssemble",
        phase: "observe",
        priority: "core",
        capabilities: ["trace.write"],
        handlerRef: "core.observability.trace"
      }
    ] satisfies LumeWorkflowHookContribution[])
  ];
}
