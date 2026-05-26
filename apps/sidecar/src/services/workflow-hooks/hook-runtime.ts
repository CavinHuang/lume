import type { LumeWorkflowHookEvent } from "./hook-events";
import type { LumeWorkflowHookExecutionResult } from "./hook-effects";
import type { LumeWorkflowHookBus } from "./hook-bus";

export interface LumeWorkflowHookRuntimeLike {
  execute(event: LumeWorkflowHookEvent): Promise<LumeWorkflowHookExecutionResult>;
}

export class LumeWorkflowHookRuntime implements LumeWorkflowHookRuntimeLike {
  constructor(private readonly bus: LumeWorkflowHookBus) {}

  execute(event: LumeWorkflowHookEvent): Promise<LumeWorkflowHookExecutionResult> {
    return this.bus.execute(event);
  }
}
