import type { CreateRuntimeCoreSessionInput } from "./run";
import type { LumeWorkflowHookRuntimeLike } from "../../workflow-hooks/hook-runtime";
import type { LumeWorkflowHookEvent } from "../../workflow-hooks/hook-events";
import type { LumeWorkflowHookExecutionResult } from "../../workflow-hooks/hook-effects";

export async function executeWorkflowHookSafely(
  workflowHooks: LumeWorkflowHookRuntimeLike | undefined,
  event: LumeWorkflowHookEvent,
): Promise<LumeWorkflowHookExecutionResult | null> {
  if (!workflowHooks) return null;
  try {
    return await workflowHooks.execute(event);
  } catch {
    return null;
  }
}

export async function applyWorkflowHookEffectsSafely(
  applyWorkflowHookEffects: CreateRuntimeCoreSessionInput["applyWorkflowHookEffects"],
  result: LumeWorkflowHookExecutionResult | null,
): Promise<void> {
  if (!applyWorkflowHookEffects || !result) return;
  try {
    await applyWorkflowHookEffects(result);
  } catch {
    // Hook observe effects must not block runtime session creation.
  }
}
