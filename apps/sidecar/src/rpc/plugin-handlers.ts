import {
  AGENT_IPC_CHANNELS,
  PLUGIN_PACKAGE_PRIVILEGED_IPC_CHANNELS,
  type AgentPluginDiagnostic,
  type AgentPluginListItem,
  type ImportLocalSkillDirectoryToWorkspaceInput,
  type InstallSkillMarketItemToWorkspaceInput,
} from "@lume/shared";
import { SidecarPluginManager } from "../services/agent-runtime/plugins/plugin-manager.js";
import { getEffectivePluginRuntimeConfig } from "../services/system/lume-config-service";
import { createDefaultPluginMarketService } from "../services/plugins/plugin-market-service";
import { createDefaultPluginBridgeService } from "../services/plugins/plugin-bridge-service";
import { assertPrivilegedCredential } from "../services/infra/privileged-auth";
import { createLogger } from "../services/infra/logger";
import {
  getGitHubSkillReview,
  installGitHubSkillToWorkspace,
} from "../services/skills/github-skill-install-service";
import {
  installSkillMarketItemToWorkspace,
  importLocalSkillDirectoryToWorkspace,
} from "../services/skills/skills-market-service";
import {
  checkBridgeStatusInputSchema,
  githubSkillReviewInputSchema,
  importLocalSkillDirectoryInputSchema,
  installGitHubSkillInputSchema,
  installMarketItemInputSchema,
  installSkillMarketItemInputSchema,
  inspectMarketSourceInputSchema,
  marketCatalogInputSchema,
  marketDetailInputSchema,
  privilegedFinalizePluginPackageInputSchema,
  privilegedPreparePluginPackageInputSchema,
  privilegedRevokePluginPackageInputSchema,
  setPluginActiveVersionInputSchema,
  setPluginEnablementInputSchema,
  uninstallPluginInputSchema,
  updatePluginInputSchema,
} from "./schemas";
import type { NotificationWriter, RpcHandler } from "./types";
import { validateInput } from "./validation";

const log = createLogger("agent-handlers");

/** Re-scan plugin directories and normalize into the LIST_PLUGINS/RELOAD_PLUGINS result shape. */
async function buildAgentPluginList(): Promise<{
  plugins: AgentPluginListItem[];
  diagnostics: AgentPluginDiagnostic[];
}> {
  const manager = new SidecarPluginManager();
  const pluginConfig = getEffectivePluginRuntimeConfig();
  const plugins = await manager.resolveEnabled({
    enabled: pluginConfig.enabled,
    directories: pluginConfig.directories,
  });
  const items: AgentPluginListItem[] = plugins.map((p) => ({
    pluginId: p.name,
    name: p.name,
    version: p.version,
    root: p.root,
    manifestFormat: p.manifestFormat,
    description: p.manifest.description,
    displayName: p.manifest.displayName,
    hooks: p.manifest.hooks,
    mcpServers: p.manifest.mcpServers,
    skills: p.manifest.skills?.length ?? 0,
    commandTools: p.manifest.commandTools?.length ?? 0,
    diagnostics: (p.diagnostics ?? []) as AgentPluginDiagnostic[],
  }));
  return {
    plugins: items,
    diagnostics: items.flatMap((item) => item.diagnostics),
  };
}

export interface PluginHandlersDeps {
  writeNotification: NotificationWriter;
}

export function createPluginHandlers(
  deps: PluginHandlersDeps,
): Record<string, RpcHandler> {
  return {
    [AGENT_IPC_CHANNELS.RELOAD_PLUGINS]: async () => {
      const result = await buildAgentPluginList();
      log.info("RELOAD_PLUGINS request", {
        count: result.plugins.length,
        names: result.plugins.map((p) => p.name),
      });
      // 通知 client 刷新能力 UI。下一次 agent attempt 自动读到新磁盘状态（无状态、按尝试加载）。
      deps.writeNotification(AGENT_IPC_CHANNELS.CAPABILITIES_CHANGED, {});
      return result;
    },
    [AGENT_IPC_CHANNELS.GET_MARKET_CATALOG]: async (params) => {
      const input = validateInput(
        marketCatalogInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_MARKET_CATALOG,
      );
      return createDefaultPluginMarketService().getMarketCatalog(input);
    },
    [AGENT_IPC_CHANNELS.GET_MARKET_DETAIL]: async (params) => {
      const input = validateInput(
        marketDetailInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_MARKET_DETAIL,
      );
      return createDefaultPluginMarketService().getMarketDetail(input);
    },
    [AGENT_IPC_CHANNELS.INSPECT_MARKET_SOURCE]: async (params) => {
      const input = validateInput(
        inspectMarketSourceInputSchema,
        params,
        AGENT_IPC_CHANNELS.INSPECT_MARKET_SOURCE,
      );
      return createDefaultPluginMarketService().inspectMarketSource(input);
    },
    [AGENT_IPC_CHANNELS.INSTALL_MARKET_ITEM]: async (params) => {
      const input = validateInput(
        installMarketItemInputSchema,
        params,
        AGENT_IPC_CHANNELS.INSTALL_MARKET_ITEM,
      );
      const result =
        await createDefaultPluginMarketService().installMarketItem(input);
      return result;
    },
    [AGENT_IPC_CHANNELS.UPDATE_PLUGIN]: async (params) => {
      const input = validateInput(
        updatePluginInputSchema,
        params,
        AGENT_IPC_CHANNELS.UPDATE_PLUGIN,
      );
      const result =
        await createDefaultPluginMarketService().updatePlugin(input);
      return result;
    },
    [AGENT_IPC_CHANNELS.UNINSTALL_PLUGIN]: async (params) => {
      const input = validateInput(
        uninstallPluginInputSchema,
        params,
        AGENT_IPC_CHANNELS.UNINSTALL_PLUGIN,
      );
      const result =
        await createDefaultPluginMarketService().uninstallPlugin(input);
      return result;
    },
    [AGENT_IPC_CHANNELS.SET_PLUGIN_ENABLEMENT]: async (params) => {
      const input = validateInput(
        setPluginEnablementInputSchema,
        params,
        AGENT_IPC_CHANNELS.SET_PLUGIN_ENABLEMENT,
      );
      const result =
        await createDefaultPluginMarketService().setPluginEnablement(input);
      return result;
    },
    [AGENT_IPC_CHANNELS.SET_PLUGIN_ACTIVE_VERSION]: async (params) => {
      const input = validateInput(
        setPluginActiveVersionInputSchema,
        params,
        AGENT_IPC_CHANNELS.SET_PLUGIN_ACTIVE_VERSION,
      );
      return createDefaultPluginMarketService().setPluginActiveVersion(input);
    },
    [PLUGIN_PACKAGE_PRIVILEGED_IPC_CHANNELS.PREPARE]: async (params) => {
      const input = validateInput(
        privilegedPreparePluginPackageInputSchema,
        params,
        PLUGIN_PACKAGE_PRIVILEGED_IPC_CHANNELS.PREPARE,
      );
      assertPrivilegedCredential(input.credential);
      return createDefaultPluginMarketService().preparePluginPackage(
        input.request,
      );
    },
    [PLUGIN_PACKAGE_PRIVILEGED_IPC_CHANNELS.FINALIZE]: async (params) => {
      const input = validateInput(
        privilegedFinalizePluginPackageInputSchema,
        params,
        PLUGIN_PACKAGE_PRIVILEGED_IPC_CHANNELS.FINALIZE,
      );
      assertPrivilegedCredential(input.credential);
      return createDefaultPluginMarketService().finalizePluginPackage(
        input.request,
      );
    },
    [PLUGIN_PACKAGE_PRIVILEGED_IPC_CHANNELS.REVOKE]: async (params) => {
      const input = validateInput(
        privilegedRevokePluginPackageInputSchema,
        params,
        PLUGIN_PACKAGE_PRIVILEGED_IPC_CHANNELS.REVOKE,
      );
      assertPrivilegedCredential(input.credential);
      return createDefaultPluginMarketService().revokePluginPackage(
        input.request,
      );
    },
    [AGENT_IPC_CHANNELS.CHECK_BRIDGE_STATUS]: async (params) => {
      const input = validateInput(
        checkBridgeStatusInputSchema,
        params,
        AGENT_IPC_CHANNELS.CHECK_BRIDGE_STATUS,
      );
      return createDefaultPluginBridgeService().checkBridgeStatus(input);
    },
    [AGENT_IPC_CHANNELS.GET_GITHUB_SKILL_REVIEW]: async (params) => {
      const input = validateInput(
        githubSkillReviewInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_GITHUB_SKILL_REVIEW,
      );
      return getGitHubSkillReview(input);
    },
    [AGENT_IPC_CHANNELS.INSTALL_GITHUB_SKILL_TO_WORKSPACE]: async (params) => {
      const input = validateInput(
        installGitHubSkillInputSchema,
        params,
        AGENT_IPC_CHANNELS.INSTALL_GITHUB_SKILL_TO_WORKSPACE,
      );
      return installGitHubSkillToWorkspace(input);
    },
    [AGENT_IPC_CHANNELS.IMPORT_LOCAL_SKILL_DIRECTORY_TO_WORKSPACE]: async (
      params,
    ) => {
      const input = validateInput(
        importLocalSkillDirectoryInputSchema,
        params,
        AGENT_IPC_CHANNELS.IMPORT_LOCAL_SKILL_DIRECTORY_TO_WORKSPACE,
      );
      return importLocalSkillDirectoryToWorkspace(
        input as ImportLocalSkillDirectoryToWorkspaceInput,
      );
    },
    [AGENT_IPC_CHANNELS.INSTALL_SKILL_MARKET_ITEM_TO_WORKSPACE]: async (
      params,
    ) => {
      const input = validateInput(
        installSkillMarketItemInputSchema,
        params,
        AGENT_IPC_CHANNELS.INSTALL_SKILL_MARKET_ITEM_TO_WORKSPACE,
      );
      return installSkillMarketItemToWorkspace(
        input as InstallSkillMarketItemToWorkspaceInput,
      );
    },
  };
}
