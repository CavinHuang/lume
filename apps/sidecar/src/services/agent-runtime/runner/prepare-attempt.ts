import type { ResolvedAgentWorkdir } from "../host-ports";
import { getRuntimeHostPorts } from "../host-ports";
import type { AgentRuntimeRunParams, AgentRuntimeRunResult } from "../runtime-core/types";
import { resolveRuntimeCoreChannelModel } from "../runtime-core/model";
import { getRuntimeCoreAgentDir } from "../runtime-core/session-store";
import type { OpenAiApiMode } from "@lume/shared";
import { getEffectiveLumeConfig } from "../../system/lume-config-service";
import type { ApiType } from "@lume/agent-sdk";
import { resolveConfiguredConnectionApiType, resolveConnectionModelMaxTokens } from "../../model-runtime/connection-provider";

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
  modelResolution: NonNullable<ReturnType<typeof resolveRuntimeCoreChannelModel>> & {
    /** 渠道配置或内置目录真实提供的输出上限(#561);缺省=仅 createFallbackModel 兜底猜测,接线时不得抬高请求。 */
    catalogMaxTokens?: number;
  };
  openaiApiMode?: OpenAiApiMode;
  apiType: ApiType;
  channelProvider: string;
  apiKey: string;
}

export async function prepareRuntimeCoreAttempt(
  params: AgentRuntimeRunParams
): Promise<PreparedRuntimeCoreAttempt | AgentRuntimeRunResult> {
  const { runtime } = params;
  const boundModel = getRuntimeHostPorts().resolveChannelModelBinding(runtime.modelRef ?? "", "chat", runtime.channelId);
  const channel = boundModel?.channel ?? getRuntimeHostPorts().listChannels().find((item) => (
    item.id === runtime.channelId && getRuntimeHostPorts().isChannelConnectionUsable(item)
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
    apiKey = getRuntimeHostPorts().decryptApiKey(channel.id);
  } catch {
    return { status: "errored", errorMessage: "runtime-core 解密 API Key 失败。" };
  }

  let workspaceName: string | undefined;
  let workspaceSlug: string | undefined;
  if (runtime.workspaceId) {
    const workspace = getRuntimeHostPorts().getWorkspace(runtime.workspaceId);
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
  // 区分目录真值与 model.maxTokens 的 32768 兜底猜测:createFallbackModel 不读目录,
  // 猜测值不得进 query 接线(#631 review);真值缺失时主链路维持 SDK 16384 默认。
  const catalogMaxTokens = resolveConnectionModelMaxTokens(
    channel,
    boundModel?.modelId ?? runtime.resolvedModelId,
  );

  let agentCwd = process.cwd();
  let resolvedWorkdir: ResolvedAgentWorkdir;
  try {
    const workdirThreadId = runtime.threadType === "subagent"
      && runtime.deliveryThreadId
      && !getRuntimeHostPorts().getThreadMeta(runtime.sessionId)
      ? runtime.deliveryThreadId
      : runtime.sessionId;
    resolvedWorkdir = getRuntimeHostPorts().resolveThreadWorkdir(workdirThreadId);
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
    modelResolution: { ...modelResolution, catalogMaxTokens },
    openaiApiMode: channel.openaiApiMode,
    apiType: resolveConfiguredConnectionApiType(channel, boundModel?.modelId ?? runtime.resolvedModelId),
    channelProvider: channel.provider,
    apiKey
  };
}
