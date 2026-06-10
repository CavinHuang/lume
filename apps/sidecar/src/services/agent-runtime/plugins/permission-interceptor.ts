import {
  checkToolPermission,
  checkFilesystemPermission,
  checkNetworkPermission,
} from "@lume/agent-sdk/plugins/permissions.js";
import type {
  InterceptorInput,
  InterceptorResult,
  PluginPermissionContext,
} from "./index.js";

const FILESYSTEM_TOOLS = new Set([
  "FileRead",
  "FileWrite",
  "FileEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
]);

const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);

export function createPluginPermissionInterceptor(
  ctx: PluginPermissionContext,
) {
  return async (input: InterceptorInput): Promise<InterceptorResult | undefined> => {
    const { toolName, input: toolInput } = input;
    const perms = ctx.permissions;

    // If no permissions declared at all, pass through to global engine
    const hasAnyPermission =
      (perms.tools && Object.keys(perms.tools).length > 0) ||
      perms.filesystem ||
      perms.network ||
      perms.shell;
    if (!hasAnyPermission) return undefined;

    // 1. tools 优先级检查 (deny > allow > ask > pass-through)
    const toolDecision = checkToolPermission(toolName, perms);
    if (toolDecision === "deny") {
      return {
        behavior: "deny",
        reason: `Plugin "${ctx.pluginName}" denied tool "${toolName}"`,
      };
    }
    if (toolDecision === "allow") {
      return { behavior: "allow" };
    }
    if (toolDecision === "ask") {
      return {
        behavior: "ask",
        reason: `Plugin "${ctx.pluginName}" requires confirmation for "${toolName}"`,
      };
    }

    // 2. filesystem 路径检查
    if (FILESYSTEM_TOOLS.has(toolName)) {
      const pathInput = (toolInput as Record<string, unknown>)?.file_path ??
        (toolInput as Record<string, unknown>)?.path;
      if (typeof pathInput === "string" && perms.filesystem) {
        const op =
          toolName === "FileRead" || toolName === "Glob" || toolName === "Grep"
            ? "read"
            : "write";
        const fsDecision = checkFilesystemPermission(
          op,
          pathInput,
          perms,
          ctx.pluginRoot,
        );
        if (fsDecision === "allow") return { behavior: "allow" };
        if (fsDecision === "ask") {
          return {
            behavior: "ask",
            reason: `Plugin "${ctx.pluginName}" needs confirmation for ${op}: ${pathInput}`,
          };
        }
      }
    }

    // 3. network 主机名检查
    if (NETWORK_TOOLS.has(toolName)) {
      const url = (toolInput as Record<string, unknown>)?.url as
        | string
        | undefined;
      if (url && perms.network) {
        try {
          const hostname = new URL(url).hostname;
          const netDecision = checkNetworkPermission(hostname, perms);
          if (netDecision === "allow") return { behavior: "allow" };
          if (netDecision === "ask") {
            return {
              behavior: "ask",
              reason: `Plugin "${ctx.pluginName}" needs confirmation to access ${hostname}`,
            };
          }
        } catch {
          // invalid URL, fall through
        }
      }
    }

    // 4. pass-through: 没有匹配任何插件权限规则，走全局权限引擎
    return undefined;
  };
}
