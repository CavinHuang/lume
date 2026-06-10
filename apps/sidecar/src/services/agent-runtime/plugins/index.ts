export { createPluginPermissionInterceptor } from "./permission-interceptor.js";

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
