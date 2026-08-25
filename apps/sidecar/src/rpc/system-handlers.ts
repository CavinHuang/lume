import {
  GENERAL_SETTINGS_IPC_CHANNELS,
  GITHUB_RELEASE_IPC_CHANNELS,
  IPC_PROTOCOL_VERSION,
  LUME_CONFIG_IPC_CHANNELS
} from "@lume/shared";
import type {
  TestSearchBackendInput,
  UpdateGeneralSettingsInput
} from "@lume/shared";
import { spawn } from "node:child_process";
import { getLatestGitHubRelease } from "../services/system/github-release-service";
import { createLogger } from "../services/infra/logger";
import { getLumeConfigYamlPath } from "../services/infra/config-paths";
import { getEffectiveLumeConfig, updateLumeConfigSection } from "../services/system/lume-config-service";
import {
  clearGeneralSettingsCaches,
  getPersistedGeneralSettings,
  updatePersistedGeneralSettings
} from "../services/system/general-settings-service";
import { testSearchBackend } from "../services/infra/search-test-service";
import { getSidecarNativeHealth } from "../services/infra/native-runtime";
import {
  clearCacheInputSchema,
  lumeConfigEffectiveInputSchema,
  lumeConfigUpdateInputSchema,
  updateGeneralSettingsInputSchema
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
    spawnDetached("explorer.exe", [path]);
    return;
  }
  if (process.platform === "darwin") {
    spawnDetached("open", [path]);
    return;
  }
  spawnDetached("xdg-open", [path]);
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
    [GENERAL_SETTINGS_IPC_CHANNELS.CLEAR_CACHE]: async (params) =>
      clearGeneralSettingsCaches(
        validateInput(
          clearCacheInputSchema,
          params ?? {},
          GENERAL_SETTINGS_IPC_CHANNELS.CLEAR_CACHE
        )
      ),
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
    [GITHUB_RELEASE_IPC_CHANNELS.GET_LATEST_RELEASE]: async () => getLatestGitHubRelease()
  };
}
