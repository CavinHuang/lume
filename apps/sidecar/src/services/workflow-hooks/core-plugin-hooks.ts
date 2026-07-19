import type { LumeWorkflowHookHandlerRegistry } from "./hook-events";

/**
 * Kept as a registered no-op until the workflow-hook contribution is migrated.
 * Explicit plugin activation is authorized and projected at the message-parts
 * boundary; workflow hooks must never infer authority from user text.
 */
export function createCorePluginHookHandlers(): LumeWorkflowHookHandlerRegistry {
  return {
    "core.plugin.skill-activation": async () => ({ effects: [] }),
  };
}
