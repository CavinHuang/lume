import type { ApiType } from "@lume/agent-sdk";

/**
 * provider/family → SDK ApiType 统一映射(#531 收敛 9 处拷贝)。
 *
 * 裁定语义：显式声明 anthropic 家族（family === "anthropic"）优先于
 * provider 猜测——anthropic 家族模型即使挂在 deepseek 等渠道上也走
 * anthropic-messages 协议（与 reading-llm-adapter 原语义对齐；
 * skill-evolution-service 原"deepseek 判定优先"语义由此被修正）。
 */
export function resolveProviderApiType(input: { family?: string; provider: string }): ApiType {
  if (input.family === "anthropic") return "anthropic-messages";
  const normalized = input.provider.trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "anthropic-compatible") return "anthropic-messages";
  if (normalized === "deepseek") return "deepseek-chat-completions";
  return "openai-completions";
}
