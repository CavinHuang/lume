import {
  checkToolPermission,
  checkFilesystemPermission,
  checkNetworkPermission,
} from "@lume/agent-sdk/plugins/permissions";
import type {
  InterceptorInput,
  InterceptorResult,
  PluginPermissionContext,
} from "./index.js";
import { createLogger } from "../../infra/logger";

const log = createLogger("plugin-permission");

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
  log.info("Plugin permission interceptor created", {
    pluginName: ctx.pluginName,
    pluginRoot: ctx.pluginRoot,
    hasFilesystem: !!ctx.permissions.filesystem,
    hasNetwork: !!ctx.permissions.network,
    hasShell: !!ctx.permissions.shell,
    hasTools: !!ctx.permissions.tools,
    hasMcpServers: !!ctx.permissions.mcpServers,
    hasHooks: !!ctx.permissions.hooks,
  });

  return async (input: InterceptorInput): Promise<InterceptorResult | undefined> => {
    const { toolName, input: toolInput } = input;
    const perms = ctx.permissions;

    // Plugin permissions are source-bound. Built-in Agent tools such as Bash must
    // not inherit the permissions of an unrelated enabled plugin.
    if (input.context.sourcePluginId !== ctx.pluginName) {
      log.debug("Tool source does not match plugin, passing through", {
        pluginName: ctx.pluginName,
        toolName,
        sourcePluginId: input.context.sourcePluginId,
      });
      return undefined;
    }

    // If no permissions declared at all, pass through to global engine
    const hasAnyPermission =
      (perms.tools && Object.keys(perms.tools).length > 0) ||
      perms.filesystem ||
      perms.network ||
      perms.shell;
    if (!hasAnyPermission) {
      log.debug("Plugin has no applicable permissions, passing through", { pluginName: ctx.pluginName, toolName });
      return undefined;
    }

    // 1. tools 优先级检查 (deny > allow > ask > pass-through)
    const toolDecision = checkToolPermission(toolName, perms);
    if (toolDecision === "deny") {
      log.warn("Plugin denied tool", { pluginName: ctx.pluginName, toolName });
      return {
        behavior: "deny",
        reason: `Plugin "${ctx.pluginName}" denied tool "${toolName}"`,
      };
    }
    if (toolDecision === "allow") {
      log.debug("Plugin allowed tool", { pluginName: ctx.pluginName, toolName });
      return { behavior: "allow" };
    }
    if (toolDecision === "ask") {
      log.info("Plugin requires confirmation for tool", { pluginName: ctx.pluginName, toolName });
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
        if (fsDecision === "allow") {
          log.debug("Plugin allowed filesystem access", { pluginName: ctx.pluginName, toolName, op, pathInput });
          return { behavior: "allow" };
        }
        if (fsDecision === "ask") {
          log.info("Plugin requires confirmation for filesystem", { pluginName: ctx.pluginName, toolName, op, pathInput });
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
          if (netDecision === "allow") {
            log.debug("Plugin allowed network access", { pluginName: ctx.pluginName, toolName, hostname });
            return { behavior: "allow" };
          }
          if (netDecision === "ask") {
            log.info("Plugin requires confirmation for network", { pluginName: ctx.pluginName, toolName, hostname });
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
    log.debug("Plugin permission passed through to global engine", { pluginName: ctx.pluginName, toolName });
    return undefined;
  };
}
