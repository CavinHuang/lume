"use client";

import { GITHUB_RELEASE_IPC_CHANNELS } from "@lume/shared";
import type {
  BrowserExtensionInfo,
  BrowserRelayStatus
} from "./types";
import type {
  GitHubRelease,
  GitHubReleaseListOptions
} from "@lume/shared";
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
