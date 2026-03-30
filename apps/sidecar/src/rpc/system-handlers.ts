import { GITHUB_RELEASE_IPC_CHANNELS, IPC_PROTOCOL_VERSION } from "@lume/shared";
import type { GitHubReleaseListOptions } from "@lume/shared";
import {
  getGitHubReleaseByTag,
  getLatestGitHubRelease,
  listGitHubReleases
} from "../services/system/github-release-service";
import { githubReleaseByTagInputSchema } from "./schemas";
import type { RpcHandler } from "./types";
import { validateInput } from "./validation";

interface SystemHandlersContext {
  getMethodNames: () => string[];
}

export function createSystemHandlers(context: SystemHandlersContext): Record<string, RpcHandler> {
  return {
    healthcheck: async () => ({
      ok: true,
      source: "sidecar",
      version: IPC_PROTOCOL_VERSION,
      pid: process.pid
    }),
    "rpc:list-methods": async () => context.getMethodNames(),
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
