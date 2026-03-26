"use client";

import {
  AUTOMATION_IPC_CHANNELS,
  CHANNEL_GATEWAY_IPC_CHANNELS,
  CHANNEL_IPC_CHANNELS,
  GITHUB_RELEASE_IPC_CHANNELS
} from "@lume/shared";
import type {
  BrowserExtensionInfo,
  BrowserRelayStatus
} from "./types";
import type {
  AutomationCreateJobInput,
  AutomationJob,
  AutomationListRunsInput,
  AutomationRun,
  Channel,
  ChannelCreateInput,
  ChannelDeliveryRecord,
  ChannelGatewayIngressInput,
  ChannelGatewayIngressResult,
  ChannelGatewayIngressStatus,
  ChannelGatewayListDeliveriesInput,
  ChannelProvider,
  ChannelSessionBinding,
  ChannelTestResult,
  ChannelUpdateInput,
  FeishuGatewayConfigInput,
  FeishuGatewayConfigView,
  FeishuGatewayTestResult,
  FetchModelsInput,
  FetchModelsResult,
  GitHubRelease,
  GitHubReleaseListOptions
} from "@lume/shared";
import { invoke } from "@tauri-apps/api/core";
import { sidecarCall } from "./core";

export async function getBrowserExtensionInfo(): Promise<BrowserExtensionInfo> {
  return sidecarCall<BrowserExtensionInfo>("browser:get-extension-info");
}

export async function installBrowserExtension(): Promise<{ path: string }> {
  return sidecarCall<{ path: string }>("browser:install-extension");
}

export async function getBrowserRelayStatus(): Promise<BrowserRelayStatus> {
  return sidecarCall<BrowserRelayStatus>("browser:get-relay-status");
}

export async function startBrowserRelay(): Promise<{
  running: boolean;
  mode: "relay";
  tabs: Array<{ sessionId: string; url?: string; title?: string }>;
}> {
  return sidecarCall<{
    running: boolean;
    mode: "relay";
    tabs: Array<{ sessionId: string; url?: string; title?: string }>;
  }>("browser:start-relay");
}

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

export async function simulateChannelGatewayIngress(
  input: ChannelGatewayIngressInput
): Promise<ChannelGatewayIngressResult> {
  return sidecarCall<ChannelGatewayIngressResult>(CHANNEL_GATEWAY_IPC_CHANNELS.SIMULATE_INGRESS, input);
}

export async function listChannelGatewayBindings(): Promise<ChannelSessionBinding[]> {
  return sidecarCall<ChannelSessionBinding[]>(CHANNEL_GATEWAY_IPC_CHANNELS.LIST_BINDINGS);
}

export async function upsertChannelGatewayBinding(input: {
  provider: ChannelProvider;
  externalChatId: string;
  externalUserId?: string;
  workspaceId?: string;
  sessionId: string;
}): Promise<ChannelSessionBinding> {
  return sidecarCall<ChannelSessionBinding>(CHANNEL_GATEWAY_IPC_CHANNELS.UPSERT_BINDING, input);
}

export async function listChannelGatewayDeliveries(
  input?: ChannelGatewayListDeliveriesInput
): Promise<ChannelDeliveryRecord[]> {
  return sidecarCall<ChannelDeliveryRecord[]>(CHANNEL_GATEWAY_IPC_CHANNELS.LIST_DELIVERIES, input ?? {});
}

export async function getChannelGatewayIngressStatus(): Promise<ChannelGatewayIngressStatus> {
  return sidecarCall<ChannelGatewayIngressStatus>(CHANNEL_GATEWAY_IPC_CHANNELS.GET_INGRESS_STATUS);
}

export async function startChannelGatewayIngress(): Promise<ChannelGatewayIngressStatus> {
  return sidecarCall<ChannelGatewayIngressStatus>(CHANNEL_GATEWAY_IPC_CHANNELS.START_INGRESS);
}

export async function stopChannelGatewayIngress(): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(CHANNEL_GATEWAY_IPC_CHANNELS.STOP_INGRESS);
}

export async function getFeishuGatewayConfig(): Promise<FeishuGatewayConfigView> {
  return sidecarCall<FeishuGatewayConfigView>(CHANNEL_GATEWAY_IPC_CHANNELS.GET_FEISHU_CONFIG);
}

export async function saveFeishuGatewayConfig(input: FeishuGatewayConfigInput): Promise<FeishuGatewayConfigView> {
  return sidecarCall<FeishuGatewayConfigView>(CHANNEL_GATEWAY_IPC_CHANNELS.SAVE_FEISHU_CONFIG, input);
}

export async function testFeishuGatewayConfig(): Promise<FeishuGatewayTestResult> {
  return sidecarCall<FeishuGatewayTestResult>(CHANNEL_GATEWAY_IPC_CHANNELS.TEST_FEISHU_CONFIG);
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
