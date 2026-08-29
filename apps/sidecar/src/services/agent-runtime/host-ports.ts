/**
 * agent-runtime 对宿主应用层(services/agent)的最小依赖面(#289)。
 *
 * harness 内核不得静态 import 应用层模块:组合根(apps/sidecar/src/index.ts)
 * 启动时调用 setRuntimeHostPorts 注入实现;单测经
 * scripts/host-ports-test-preload.ts(--preload)注入同一组真实现。
 *
 * 领域类型一律 import type(运行时零依赖);方向守卫测试
 * (runtime-core/layering-boundary.test.ts)只放行该形式。
 */
import type { AgentDefinition } from "@lume/agent-sdk";
import type { AgentMessage, AgentThreadMeta, AgentWorkspace, Channel, ProviderApiFamily, SDKMessage } from "@lume/shared";
import type {
  AgentThreadMetaUpdates,
  CreateAgentThreadOptions,
} from "../agent/agent-thread-manager";
import type { ResolvedAgentWorkdir } from "../agent/agent-workdir-resolver";
import type {
  DynamicContext,
  EnabledPluginContextItem,
  SystemPromptContext,
} from "../agent/agent-prompt-builder";
import type { ResolveAgentDynamicContextInput } from "../agent/agent-runtime-context";

export type {
  AgentThreadMetaUpdates,
  DynamicContext,
  EnabledPluginContextItem,
  ResolvedAgentWorkdir,
  SystemPromptContext,
};

export interface RuntimeHostPorts {
  getThreadMeta(id: string): AgentThreadMeta | undefined;
  tryUpdateThreadMeta(id: string, updates: AgentThreadMetaUpdates): AgentThreadMeta | null;
  updateThreadMeta(id: string, updates: AgentThreadMetaUpdates): AgentThreadMeta;
  createThreadWithModelRef(
    title?: string,
    modelRef?: string,
    channelId?: string,
    workspaceId?: string,
    parentThreadId?: string,
    modelId?: string,
    options?: CreateAgentThreadOptions
  ): AgentThreadMeta;
  getThreadMessages(id: string): AgentMessage[];
  getThreadSDKMessages(id: string): SDKMessage[];
  getWorkspace(id: string): AgentWorkspace | undefined;
  resolveThreadWorkdir(threadId: string): ResolvedAgentWorkdir;
  /** 线程绑定的 worktree 已失效时清除并广播，返回更新后的 meta；无绑定/仍有效返回 null。 */
  clearInvalidThreadWorktree(threadId: string): Promise<AgentThreadMeta | null>;
  /** 绑定/解绑线程活动 worktree（校验 linked + 主仓库根，成功即广播）。 */
  bindThreadWorktree(threadId: string, worktreePath: string | null): Promise<AgentThreadMeta>;
  resolveThreadAttachmentPath(
    workspaceSlug: string | undefined,
    sessionId: string,
    threadPath: string
  ): string;
  toThreadRelativePath(
    workspaceSlug: string | undefined,
    sessionId: string,
    targetPath: string
  ): string;
  buildBuiltinAgents(): Record<string, AgentDefinition>;
  loadCustomAgents(workspaceSlug?: string): Record<string, AgentDefinition>;
  buildSystemPromptAppend(ctx: SystemPromptContext): string;
  buildDynamicContext(ctx: DynamicContext): string;
  resolveDynamicContextInput(input: ResolveAgentDynamicContextInput): DynamicContext;
  /** 渠道读取面(#289 分层切边;实现 services/channel/channel-manager)。 */
  listChannels(): Channel[];
  getChannelById(id: string): Channel | undefined;
  isChannelConnectionUsable(channel: Channel): boolean;
  decryptApiKey(channelId: string): string;
  resolveChannelModelBinding(
    modelRef: string,
    capability?: "chat" | "embedding",
    preferredConnectionId?: string
  ): { channel: Channel; modelId: string; family: ProviderApiFamily } | null;
}

let hostPorts: RuntimeHostPorts | null = null;

export function setRuntimeHostPorts(ports: RuntimeHostPorts): void {
  hostPorts = ports;
}

export function getRuntimeHostPorts(): RuntimeHostPorts {
  if (!hostPorts) {
    throw new Error(
      "RuntimeHostPorts 未注入:生产入口须调用 setRuntimeHostPorts();单测经 --preload apps/sidecar/scripts/host-ports-test-preload.ts 注入"
    );
  }
  return hostPorts;
}
