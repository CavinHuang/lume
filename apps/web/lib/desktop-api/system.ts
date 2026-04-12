import {
  AUTOMATION_IPC_CHANNELS,
  CHANNEL_IPC_CHANNELS,
  GITHUB_RELEASE_IPC_CHANNELS,
  SYSTEM_CONFIG_IPC_CHANNELS,
  UI_STATE_IPC_CHANNELS
} from "@lume/shared";
import type {
  AutomationCreateJobInput,
  AutomationJob,
  AutomationListRunsInput,
  AutomationRun,
  Channel,
  ChannelCreateInput,
  ChannelTestResult,
  ChannelUpdateInput,
  FetchModelsInput,
  FetchModelsResult,
  GitHubRelease,
  GitHubReleaseListOptions,
  EffectiveSystemConfig,
  NetworkDiagnosticResult,
  PersistedUiState,
  UpdateUiStateInput
} from "@lume/shared";
import { invoke } from "@tauri-apps/api/core";
import { sidecarCall } from "./core";

export async function getLatestGitHubRelease(): Promise<GitHubRelease | null> {
  return sidecarCall<GitHubRelease | null>(GITHUB_RELEASE_IPC_CHANNELS.GET_LATEST_RELEASE);
}

export async function listGitHubReleases(
  options?: GitHubReleaseListOptions
): Promise<GitHubRelease[]> {
  return sidecarCall<GitHubRelease[]>(GITHUB_RELEASE_IPC_CHANNELS.LIST_RELEASES, options ?? {});
}

export async function getGitHubReleaseByTag(tag: string): Promise<GitHubRelease | null> {
  return sidecarCall<GitHubRelease | null>(GITHUB_RELEASE_IPC_CHANNELS.GET_RELEASE_BY_TAG, { tag });
}

export async function getPersistedUiState(): Promise<PersistedUiState> {
  return sidecarCall<PersistedUiState>(UI_STATE_IPC_CHANNELS.GET);
}

export async function updatePersistedUiState(input: UpdateUiStateInput): Promise<PersistedUiState> {
  return sidecarCall<PersistedUiState>(UI_STATE_IPC_CHANNELS.UPDATE, input);
}

export async function getEffectiveSystemConfig(workspaceSlug?: string): Promise<EffectiveSystemConfig> {
  return sidecarCall<EffectiveSystemConfig>(
    SYSTEM_CONFIG_IPC_CHANNELS.GET_EFFECTIVE,
    workspaceSlug ? { workspaceSlug } : {}
  );
}

export async function updateSystemConfigSection(path: string, value: unknown): Promise<EffectiveSystemConfig> {
  return sidecarCall<EffectiveSystemConfig>(SYSTEM_CONFIG_IPC_CHANNELS.UPDATE_SECTION, { path, value });
}

export async function runNetworkDiagnostic(): Promise<NetworkDiagnosticResult> {
  return sidecarCall<NetworkDiagnosticResult>(SYSTEM_CONFIG_IPC_CHANNELS.NETWORK_DIAGNOSTIC);
}

export async function listAutomationJobs(): Promise<AutomationJob[]> {
  return sidecarCall<AutomationJob[]>(AUTOMATION_IPC_CHANNELS.LIST_JOBS);
}

export async function createAutomationJob(input: AutomationCreateJobInput): Promise<AutomationJob> {
  return sidecarCall<AutomationJob>(AUTOMATION_IPC_CHANNELS.CREATE_JOB, input);
}

export async function updateAutomationJob(
  input: import("@lume/shared").AutomationUpdateJobInput
): Promise<AutomationJob> {
  return sidecarCall<AutomationJob>(AUTOMATION_IPC_CHANNELS.UPDATE_JOB, input);
}

export async function deleteAutomationJob(id: string): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(AUTOMATION_IPC_CHANNELS.DELETE_JOB, { id });
}

export async function listAutomationRuns(input?: AutomationListRunsInput): Promise<AutomationRun[]> {
  return sidecarCall<AutomationRun[]>(AUTOMATION_IPC_CHANNELS.LIST_RUNS, input ?? {});
}

export async function runAutomationJobNow(id: string): Promise<AutomationRun> {
  return sidecarCall<AutomationRun>(AUTOMATION_IPC_CHANNELS.RUN_NOW, { id });
}

export async function listChannels(): Promise<Channel[]> {
  return sidecarCall<Channel[]>(CHANNEL_IPC_CHANNELS.LIST);
}

export async function createChannel(input: ChannelCreateInput): Promise<Channel> {
  return sidecarCall<Channel>(CHANNEL_IPC_CHANNELS.CREATE, input);
}

export async function updateChannel(id: string, input: ChannelUpdateInput): Promise<Channel> {
  return sidecarCall<Channel>(CHANNEL_IPC_CHANNELS.UPDATE, { id, input });
}

export async function deleteChannel(id: string): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(CHANNEL_IPC_CHANNELS.DELETE, { id });
}

export async function testChannel(channelId: string): Promise<ChannelTestResult> {
  return sidecarCall<ChannelTestResult>(CHANNEL_IPC_CHANNELS.TEST, { channelId });
}

export async function decryptChannelApiKey(channelId: string): Promise<string> {
  return sidecarCall<string>(CHANNEL_IPC_CHANNELS.DECRYPT_KEY, { channelId });
}

export async function testChannelDirect(input: FetchModelsInput): Promise<ChannelTestResult> {
  return sidecarCall<ChannelTestResult>(CHANNEL_IPC_CHANNELS.TEST_DIRECT, input);
}

export async function fetchChannelModels(input: FetchModelsInput): Promise<FetchModelsResult> {
  return sidecarCall<FetchModelsResult>(CHANNEL_IPC_CHANNELS.FETCH_MODELS, input);
}

export async function openFolderDialog(): Promise<{ path: string | null }> {
  try {
    const result = await invoke<{ path: string | null }>("open_folder_dialog");
    if (result && "path" in result) {
      return result;
    }
  } catch {
    // Fall back to browser flow in caller.
  }
  return { path: null };
}

export {
  getEffectiveLumeConfig,
  getLumeConfigSourcePath,
  onLumeConfigChanged,
  openLumeConfigSourceFile
} from "./lume-config";
