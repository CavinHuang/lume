import { getAgentWorkspace } from "../../agent/agent-workspace-manager";
import { decryptApiKey, listChannels, resolveChannelModelBinding } from "../../channel/channel-manager";
import { getAgentSessionWorkspacePath } from "../../infra/config-paths";
import type { AgentRuntimeRunParams, AgentRuntimeRunResult } from "../runner/types";
import { resolveRuntimeCoreChannelModel } from "./model";
import { getRuntimeCoreAgentDir } from "./session-store";

export interface PreparedRuntimeCoreAttempt {
  agentCwd: string;
  agentDir: string;
  workspaceName?: string;
  workspaceSlug?: string;
  modelResolution: NonNullable<ReturnType<typeof resolveRuntimeCoreChannelModel>>;
  apiKey: string;
}

export async function prepareRuntimeCoreAttempt(
  params: AgentRuntimeRunParams
): Promise<PreparedRuntimeCoreAttempt | AgentRuntimeRunResult> {
  const { runtime } = params;
  const boundModel = resolveChannelModelBinding(runtime.modelRef ?? "", "chat");
  const channel = boundModel?.channel ?? listChannels().find((item) => item.id === runtime.channelId);
  if (!channel) {
    return { status: "errored", errorMessage: "runtime-core 未找到可用渠道。" };
  }

  let apiKey = "";
  try {
    apiKey = decryptApiKey(runtime.channelId);
  } catch {
    return { status: "errored", errorMessage: "runtime-core 解密 API Key 失败。" };
  }

  const modelResolution = resolveRuntimeCoreChannelModel({
    channel,
    channelProvider: channel.provider,
    requestedModelRefOrId: runtime.modelRef ?? boundModel?.modelId ?? runtime.resolvedModelId,
    baseUrl: channel.baseUrl
  });
  if (!modelResolution) {
    return {
      status: "errored",
      errorMessage: `runtime-core 未找到模型: ${runtime.modelRef ?? `${channel.provider}/${runtime.resolvedModelId}`}`
    };
  }

  let agentCwd = process.cwd();
  let workspaceName: string | undefined;
  let workspaceSlug: string | undefined;
  if (runtime.workspaceId) {
    const workspace = getAgentWorkspace(runtime.workspaceId);
    if (workspace) {
      workspaceName = workspace.name;
      workspaceSlug = workspace.slug;
      agentCwd = getAgentSessionWorkspacePath(workspace.slug, runtime.sessionId);
    }
  }

  return {
    agentCwd,
    agentDir: getRuntimeCoreAgentDir(),
    workspaceName,
    workspaceSlug,
    modelResolution,
    apiKey
  };
}
