import type { LLMProvider } from "@lume/agent-sdk";
import { resolveChannelModelBinding } from "../channel/channel-manager";
import { createLazyConnectionLlmProvider } from "../model-runtime/connection-provider";

/**
 * 按 modelRef 解析 Chat 渠道绑定并创建惰性 LLM provider。
 * 供 memory-v2 / skills 的各 LLM 尝试工厂复用；调用方须先保证绑定存在
 * （如 `!binding && !createProvider` 守卫），绑定缺失时显式抛错，
 * 与原先 `binding!` 的隐式空引用失败等价且信息更明确。
 */
export function resolveChatProvider(modelRef: string): LLMProvider {
  const binding = resolveChannelModelBinding(modelRef, "chat");
  if (!binding) {
    throw new Error(`未解析到 Chat 模型绑定: ${modelRef}`);
  }
  return createLazyConnectionLlmProvider({ connectionId: binding.channel.id, modelId: binding.modelId });
}
