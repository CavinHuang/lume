import { getAgentWorkspace } from "../../agent/agent-workspace-manager";
import { getAgentThreadMeta } from "../../agent/agent-thread-manager";
import { decryptApiKey, isChannelConnectionUsable, listChannels, resolveChannelModelBinding } from "../../channel/channel-manager";
import { resolveAgentThreadWorkdir, type ResolvedAgentWorkdir } from "../../agent/agent-workdir-resolver";
import type { AgentRuntimeRunParams, AgentRuntimeRunResult } from "../runner/types";
import { resolveRuntimeCoreChannelModel } from "./model";
import { getRuntimeCoreAgentDir } from "./session-store";
import type { OpenAiApiMode } from "@lume/shared";
import { getEffectiveLumeConfig } from "../../system/lume-config-service";
import type { ApiType } from "@lume/agent-sdk";
import { resolveConfiguredConnectionApiType } from "../../model-runtime/connection-provider";

export interface PreparedRuntimeCoreAttempt {
  agentCwd: string;
  lumeWorkDir: string;
  filesRoot: string;
  plansRoot: string;
  artifactsRoot: string;
  projectRoot?: string;
  fileContextId: string;
  agentDir: string;
  workspaceName?: string;
  workspaceSlug?: string;
  modelResolution: NonNullable<ReturnType<typeof resolveRuntimeCoreChannelModel>>;
  openaiApiMode?: OpenAiApiMode;
  apiType: ApiType;
  channelProvider: string;
  apiKey: string;
}

export async function prepareRuntimeCoreAttempt(
  params: AgentRuntimeRunParams
): Promise<PreparedRuntimeCoreAttempt | AgentRuntimeRunResult> {
  const { runtime } = params;
  const boundModel = resolveChannelModelBinding(runtime.modelRef ?? "", "chat", runtime.channelId);
  const channel = boundModel?.channel ?? listChannels().find((item) => (
    item.id === runtime.channelId && isChannelConnectionUsable(item)
  ));
  if (!channel) {
    return { status: "errored", errorMessage: "runtime-core 未找到可用渠道。" };
  }
  if (channel.models.length > 0 && !channel.models.some((model) => (
    model.enabled && model.capabilities?.chat !== false
  ))) {
    return { status: "errored", errorMessage: "runtime-core 当前连接没有已启用的对话模型。" };
  }

  let apiKey = "";
  try {
    apiKey = decryptApiKey(channel.id);
  } catch {
    return { status: "errored", errorMessage: "runtime-core 解密 API Key 失败。" };
  }

  let workspaceName: string | undefined;
  let workspaceSlug: string | undefined;
  if (runtime.workspaceId) {
    const workspace = getAgentWorkspace(runtime.workspaceId);
    if (!workspace) {
      return { status: "errored", errorMessage: `项目不存在或已移除: ${runtime.workspaceId}` };
    }
    workspaceName = workspace.name;
    workspaceSlug = workspace.slug;
  }
  const contextWindowOverrides = getEffectiveLumeConfig(workspaceSlug).models?.contextWindows;

  const modelResolution = resolveRuntimeCoreChannelModel({
    channel,
    channelProvider: channel.provider,
    requestedModelRefOrId: boundModel?.modelId ?? runtime.resolvedModelId,
    baseUrl: channel.baseUrl,
    contextWindowOverrides
  });
  if (!modelResolution) {
    return {
      status: "errored",
      errorMessage: `runtime-core 未找到模型: ${runtime.modelRef ?? `${channel.provider}/${runtime.resolvedModelId}`}`
    };
  }

  let agentCwd = process.cwd();
  let resolvedWorkdir: ResolvedAgentWorkdir;
  try {
    const workdirThreadId = runtime.threadType === "subagent"
      && runtime.deliveryThreadId
      && !getAgentThreadMeta(runtime.sessionId)
      ? runtime.deliveryThreadId
      : runtime.sessionId;
    resolvedWorkdir = resolveAgentThreadWorkdir(workdirThreadId);
    agentCwd = resolvedWorkdir.agentCwd;
  } catch (error) {
    return {
      status: "errored",
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }

  return {
    agentCwd,
    lumeWorkDir: resolvedWorkdir.lumeWorkDir,
    filesRoot: resolvedWorkdir.filesRoot,
    plansRoot: resolvedWorkdir.plansRoot,
    artifactsRoot: resolvedWorkdir.artifactsRoot,
    ...(resolvedWorkdir.projectRoot ? { projectRoot: resolvedWorkdir.projectRoot } : {}),
    fileContextId: resolvedWorkdir.fileContextId,
    agentDir: getRuntimeCoreAgentDir(),
    workspaceName,
    workspaceSlug,
    modelResolution,
    openaiApiMode: channel.openaiApiMode,
    apiType: resolveConfiguredConnectionApiType(channel, boundModel?.modelId ?? runtime.resolvedModelId),
    channelProvider: channel.provider,
    apiKey
  };
}
