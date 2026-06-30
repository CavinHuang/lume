import {
  GENERAL_SETTINGS_IPC_CHANNELS,
  GITHUB_RELEASE_IPC_CHANNELS,
  IPC_PROTOCOL_VERSION,
  LUME_CONFIG_IPC_CHANNELS,
  SYSTEM_CONFIG_IPC_CHANNELS,
  UI_STATE_IPC_CHANNELS
} from "@lume/shared";
import type {
  GitHubReleaseListOptions,
  NetworkDiagnosticResult,
  ReadLogFileInput,
  TestSearchBackendInput,
  UpdateGeneralSettingsInput,
  UpdateUiStateInput
} from "@lume/shared";
import { spawn } from "node:child_process";
import {
  getGitHubReleaseByTag,
  getLatestGitHubRelease,
  listGitHubReleases
} from "../services/system/github-release-service";
import { fetchWithProxy } from "../services/infra/proxy-fetch";
import { createLogger, getLogsDir } from "../services/infra/logger";
import { getLumeConfigYamlPath } from "../services/infra/config-paths";
import { getEffectiveLumeConfig, updateLumeConfigSection } from "../services/system/lume-config-service";
import { getEffectiveSystemConfig, updatePrimarySystemConfigSection } from "../services/system/system-config-service";
import {
  clearGeneralSettingsCaches,
  getPersistedGeneralSettings,
  updatePersistedGeneralSettings
} from "../services/system/general-settings-service";
import {
  exportAllLogFiles,
  listLogFiles,
  readLogFile
} from "../services/infra/log-viewer-service";
import { testSearchBackend } from "../services/infra/search-test-service";
import { getActiveProxyConfig } from "../services/system/proxy-settings-manager";
import { getPersistedUiState, updatePersistedUiState } from "../services/system/ui-state-service";
import { getSidecarNativeHealth } from "../services/infra/native-runtime";
import {
  clearCacheInputSchema,
  githubReleaseByTagInputSchema,
  lumeConfigEffectiveInputSchema,
  lumeConfigUpdateInputSchema,
  systemConfigUpdateInputSchema,
  readLogFileInputSchema,
  updateGeneralSettingsInputSchema,
  updateUiStateInputSchema
} from "./schemas";
import type { RpcHandler } from "./types";
import { validateInput } from "./validation";

const log = createLogger("system-handlers");

interface SystemHandlersContext {
  getMethodNames: () => string[];
}

function spawnDetached(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

function openInSystem(path: string): void {
  if (process.platform === "win32") {
    spawnDetached("cmd", ["/c", "start", "", path]);
    return;
  }
  if (process.platform === "darwin") {
    spawnDetached("open", [path]);
    return;
  }
  spawnDetached("xdg-open", [path]);
}

async function runNetworkDiagnostic(): Promise<NetworkDiagnosticResult> {
  const targets = [
    { name: "Jina", url: "https://api.jina.ai/v1/embeddings", method: "POST" as const, body: JSON.stringify({ model: "jina-embeddings-v5-text-small", input: ["hello lume"] }) },
    { name: "DuckDuckGo", url: "https://duckduckgo.com/html/?q=lume", method: "GET" as const },
    { name: "Brave", url: "https://api.search.brave.com/res/v1/web/search?q=lume&count=1", method: "GET" as const }
  ];

  const checks = await Promise.all(targets.map(async (target) => {
    try {
      const response = await fetchWithProxy(target.url, {
        method: target.method,
        headers: target.method === "POST" ? { "Content-Type": "application/json" } : undefined,
        body: target.body,
      });
      return {
        name: target.name,
        url: target.url,
        ok: response.ok,
        statusCode: response.status,
        ...(response.ok ? {} : { error: `HTTP ${response.status}` })
      };
    } catch (error) {
      return {
        name: target.name,
        url: target.url,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }));

  return {
    proxy: getActiveProxyConfig(),
    checks
  };
}

export function createSystemHandlers(context: SystemHandlersContext): Record<string, RpcHandler> {
  return {
    healthcheck: async () => ({
      ok: true,
      source: "sidecar",
      version: IPC_PROTOCOL_VERSION,
      pid: process.pid,
      native: getSidecarNativeHealth()
    }),
    "rpc:list-methods": async () => context.getMethodNames(),
    [UI_STATE_IPC_CHANNELS.GET]: async () => getPersistedUiState(),
    [UI_STATE_IPC_CHANNELS.UPDATE]: async (params) =>
      updatePersistedUiState(
        validateInput(updateUiStateInputSchema, params, UI_STATE_IPC_CHANNELS.UPDATE) as UpdateUiStateInput
      ),
    [GENERAL_SETTINGS_IPC_CHANNELS.GET]: async () => getPersistedGeneralSettings(),
    [GENERAL_SETTINGS_IPC_CHANNELS.UPDATE]: async (params) => {
      const input = validateInput(
        updateGeneralSettingsInputSchema,
        params ?? {},
        GENERAL_SETTINGS_IPC_CHANNELS.UPDATE
      ) as UpdateGeneralSettingsInput;
      log.info("[Agent 设置] 更新通用设置", { keys: Object.keys(input) });
      return updatePersistedGeneralSettings(input);
    },
    [GENERAL_SETTINGS_IPC_CHANNELS.OPEN_LOGS_DIR]: async () => {
      openInSystem(getLogsDir());
      return { ok: true };
    },
    [GENERAL_SETTINGS_IPC_CHANNELS.CLEAR_CACHE]: async (params) =>
      clearGeneralSettingsCaches(
        validateInput(
          clearCacheInputSchema,
          params ?? {},
          GENERAL_SETTINGS_IPC_CHANNELS.CLEAR_CACHE
        )
      ),
    [GENERAL_SETTINGS_IPC_CHANNELS.LIST_LOG_FILES]: async () => listLogFiles(),
    [GENERAL_SETTINGS_IPC_CHANNELS.READ_LOG_FILE]: async (params) =>
      readLogFile(
        validateInput(
          readLogFileInputSchema,
          params ?? {},
          GENERAL_SETTINGS_IPC_CHANNELS.READ_LOG_FILE
        ) as ReadLogFileInput
      ),
    [GENERAL_SETTINGS_IPC_CHANNELS.EXPORT_LOGS]: async () => {
      const result = exportAllLogFiles();
      openInSystem(result.path);
      return { ...result, path: "" };
    },
    [GENERAL_SETTINGS_IPC_CHANNELS.TEST_SEARCH_BACKEND]: async (params) => {
      const input = (params ?? {}) as TestSearchBackendInput;
      return testSearchBackend(input);
    },
    [LUME_CONFIG_IPC_CHANNELS.GET_EFFECTIVE]: async (params) => {
      const input = validateInput(
        lumeConfigEffectiveInputSchema,
        params ?? {},
        LUME_CONFIG_IPC_CHANNELS.GET_EFFECTIVE
      );
      return getEffectiveLumeConfig(input.workspaceSlug);
    },
    [LUME_CONFIG_IPC_CHANNELS.UPDATE_SECTION]: async (params) => {
      const input = validateInput(
        lumeConfigUpdateInputSchema,
        params,
        LUME_CONFIG_IPC_CHANNELS.UPDATE_SECTION
      );
      log.info("[Agent 设置] 更新 lume 配置", { path: input.path });
      return updateLumeConfigSection(input);
    },
    [LUME_CONFIG_IPC_CHANNELS.GET_SOURCE_PATH]: async () => ({
      sourcePath: getLumeConfigYamlPath()
    }),
    [LUME_CONFIG_IPC_CHANNELS.OPEN_SOURCE_FILE]: async () => {
      openInSystem(getLumeConfigYamlPath());
      return { ok: true };
    },
    [SYSTEM_CONFIG_IPC_CHANNELS.GET_EFFECTIVE]: async (params) => {
      const input = validateInput(
        lumeConfigEffectiveInputSchema,
        params ?? {},
        SYSTEM_CONFIG_IPC_CHANNELS.GET_EFFECTIVE
      );
      return getEffectiveSystemConfig(input.workspaceSlug);
    },
    [SYSTEM_CONFIG_IPC_CHANNELS.UPDATE_SECTION]: async (params) => {
      const input = validateInput(
        systemConfigUpdateInputSchema,
        params,
        SYSTEM_CONFIG_IPC_CHANNELS.UPDATE_SECTION
      );
      log.info("[Agent 设置] 更新系统配置", { path: input.path });
      return updatePrimarySystemConfigSection(input);
    },
    [SYSTEM_CONFIG_IPC_CHANNELS.NETWORK_DIAGNOSTIC]: async () => runNetworkDiagnostic(),
    [GITHUB_RELEASE_IPC_CHANNELS.GET_LATEST_RELEASE]: async () => getLatestGitHubRelease(),
    [GITHUB_RELEASE_IPC_CHANNELS.LIST_RELEASES]: async (params) =>
      listGitHubReleases((params ?? {}) as GitHubReleaseListOptions),
    [GITHUB_RELEASE_IPC_CHANNELS.GET_RELEASE_BY_TAG]: async (params) => {
      const input = validateInput(
        githubReleaseByTagInputSchema,
        params,
        GITHUB_RELEASE_IPC_CHANNELS.GET_RELEASE_BY_TAG
      );
      return getGitHubReleaseByTag(input.tag);
    }
  };
}
