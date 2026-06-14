export { createPluginPermissionInterceptor } from "./permission-interceptor.js";
export { PluginRegistry } from "./plugin-registry.js";
export { PluginPermissionRuntime } from "./permission-runtime.js";
export type { PluginPermissionRuntimeInput, SensitiveCheckResult, RuntimeStateResult } from "./permission-runtime.js";
export { FilePluginStateStore } from "./plugin-state-store.js";
export { resolvePluginCapabilities } from "./capability-resolver.js";
export type {
  ResolvedPluginCapability,
  ResolvedPluginCapabilitiesResult,
  ResolvedSkill,
  ResolvedMcpServer,
  ResolvedCommandTool,
} from "./capability-resolver.js";

export interface PluginPermissionContext {
  pluginName: string;
  pluginRoot: string;
  permissions: Record<string, unknown>;
}

export interface InterceptorInput {
  toolName: string;
  input: unknown;
  context: {
    cwd: string;
    threadId: string;
  };
}

export interface InterceptorResult {
  behavior: "allow" | "deny" | "ask";
  reason?: string;
  updatedInput?: unknown;
}
