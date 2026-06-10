import type { LumeConfigHooksInternalSection } from "@lume/shared";
import { createCoreMemoryHookHandlers } from "./core-memory-hooks";
import { createCoreObservabilityHookHandlers } from "./core-observability-hooks";
import { createCorePluginHookHandlers } from "./core-plugin-hooks";
import { createCoreSecurityHookHandlers } from "./core-security-hooks";
import { createCoreWorkflowHookContributions } from "./contributions";
import { LumeWorkflowHookBus } from "./hook-bus";
import type { LumeWorkflowHookEvent } from "./hook-events";
import type { LumeWorkflowHookExecutionResult } from "./hook-effects";
import type { LumeWorkflowHookHandlerContext } from "./hook-services";

export interface LumeWorkflowHookRuntimeLike {
  execute(event: LumeWorkflowHookEvent): Promise<LumeWorkflowHookExecutionResult>;
}

export class LumeWorkflowHookRuntime implements LumeWorkflowHookRuntimeLike {
  constructor(private readonly bus: LumeWorkflowHookBus) {}

  execute(event: LumeWorkflowHookEvent): Promise<LumeWorkflowHookExecutionResult> {
    return this.bus.execute(event);
  }
}

export function createLumeWorkflowHookRuntime(input: {
  config: LumeConfigHooksInternalSection;
  services: LumeWorkflowHookHandlerContext["services"];
}): LumeWorkflowHookRuntime {
  return new LumeWorkflowHookRuntime(new LumeWorkflowHookBus({
    contributions: createCoreWorkflowHookContributions(input.config),
    handlers: {
      ...createCoreMemoryHookHandlers(),
      ...createCorePluginHookHandlers(),
      ...createCoreSecurityHookHandlers(),
      ...createCoreObservabilityHookHandlers()
    },
    context: { services: input.services }
  }));
}
