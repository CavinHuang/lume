import type { LLMProvider } from "@lume/agent-sdk";
import { resolveChannelModelBinding } from "../channel/channel-manager";
import { createLazyConnectionLlmProvider } from "../model-runtime/connection-provider";

export interface ResolvedChatProvider {
  provider: LLMProvider;
  /** 绑定解析出的实际模型 id，供 createMessage 的 model 参数使用 */
  modelId: string;
}

/**
 * 按 modelRef 解析 Chat 渠道绑定并创建惰性 LLM provider。
 * 供 memory-v2 / skills / persona 的各 LLM 尝试工厂复用；绑定缺失时显式抛错，
 * 与原先 `binding!` 的隐式空引用失败等价且信息更明确。
 */
export function resolveChatProvider(modelRef: string): ResolvedChatProvider {
  const binding = resolveChannelModelBinding(modelRef, "chat");
  if (!binding) {
    throw new Error(`未解析到 Chat 模型绑定: ${modelRef}`);
  }
  return {
    provider: createLazyConnectionLlmProvider({ connectionId: binding.channel.id, modelId: binding.modelId }),
    modelId: binding.modelId
  };
}
