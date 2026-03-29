import type { ProviderType } from "@lume/shared";

import anthropicIcon from "@lobehub/icons-static-png/light/anthropic.png";
import chatglmIcon from "@lobehub/icons-static-png/light/chatglm-color.png";
import claudeIcon from "@lobehub/icons-static-png/light/claude-color.png";
import cohereIcon from "@lobehub/icons-static-png/light/cohere-color.png";
import deepseekIcon from "@lobehub/icons-static-png/light/deepseek-color.png";
import doubaoIcon from "@lobehub/icons-static-png/light/doubao-color.png";
import geminiIcon from "@lobehub/icons-static-png/light/gemini-color.png";
import grokIcon from "@lobehub/icons-static-png/light/grok.png";
import hunyuanIcon from "@lobehub/icons-static-png/light/hunyuan-color.png";
import minimaxIcon from "@lobehub/icons-static-png/light/minimax-color.png";
import moonshotIcon from "@lobehub/icons-static-png/light/moonshot.png";
import openaiIcon from "@lobehub/icons-static-png/light/openai.png";
import qwenIcon from "@lobehub/icons-static-png/light/qwen-color.png";
import sparkIcon from "@lobehub/icons-static-png/light/spark.png";
import wenxinIcon from "@lobehub/icons-static-png/light/wenxin-color.png";
import yiIcon from "@lobehub/icons-static-png/light/yi-color.png";
import zhipuIcon from "@lobehub/icons-static-png/light/zhipu-color.png";

const MODEL_LOGO_MAP: Array<[RegExp, string]> = [
  [/gpt|o1|o3|o4|dall|codex/i, openaiIcon],
  [/(claude|anthropic-)/i, claudeIcon],
  [/deepseek/i, deepseekIcon],
  [/gemini|veo|gemma/i, geminiIcon],
  [/(qwen|qwq|qvq|wan-)/i, qwenIcon],
  [/grok/i, grokIcon],
  [/moonshot|kimi/i, moonshotIcon],
  [/doubao|ep-202/i, doubaoIcon],
  [/zhipu|cogview/i, zhipuIcon],
  [/glm/i, chatglmIcon],
  [/llama/i, chatglmIcon],
  [/yi-/i, yiIcon],
  [/ernie-|tao-/i, wenxinIcon],
  [/hunyuan/i, hunyuanIcon],
  [/sparkdesk|generalv/i, sparkIcon],
  [/minimax/i, minimaxIcon],
  [/cohere|command/i, cohereIcon]
];

const PROVIDER_LOGO_MAP: Record<ProviderType, string> = {
  anthropic: anthropicIcon,
  openai: openaiIcon,
  openrouter: openaiIcon,
  deepseek: deepseekIcon,
  google: geminiIcon,
  zai: zhipuIcon,
  moonshot: moonshotIcon,
  zhipu: zhipuIcon,
  minimax: minimaxIcon,
  "minimax-cn": minimaxIcon,
  doubao: doubaoIcon,
  qwen: qwenIcon,
  "qwen-portal": qwenIcon,
  "kimi-coding": moonshotIcon,
  opencode: openaiIcon,
  custom: openaiIcon
};

const URL_LOGO_MAP: Array<[RegExp, string]> = [
  [/moonshot\.cn|kimi/i, moonshotIcon],
  [/bigmodel\.cn|zhipuai/i, zhipuIcon],
  [/minimax/i, minimaxIcon],
  [/volces\.com|volcengine/i, doubaoIcon],
  [/dashscope|aliyuncs/i, qwenIcon],
  [/deepseek/i, deepseekIcon],
  [/anthropic/i, anthropicIcon],
  [/openai\.com/i, openaiIcon],
  [/googleapis|generativelanguage/i, geminiIcon],
  [/grok|x\.ai/i, grokIcon],
  [/spark-api|xfyun/i, sparkIcon],
  [/hunyuan/i, hunyuanIcon],
  [/ernie|baidu/i, wenxinIcon],
  [/yi\.com|lingyiwanwu/i, yiIcon]
];

const defaultIcon = "/models/default.png";

export function getModelLogoById(modelId: string): string | undefined {
  if (!modelId) return undefined;
  for (const [pattern, logo] of MODEL_LOGO_MAP) {
    if (pattern.test(modelId)) return logo;
  }
  return undefined;
}

export function getModelLogo(modelId: string, provider?: ProviderType): string {
  return getModelLogoById(modelId) ?? (provider ? PROVIDER_LOGO_MAP[provider] : undefined) ?? defaultIcon;
}

export function getProviderLogo(provider: ProviderType): string {
  return PROVIDER_LOGO_MAP[provider] ?? defaultIcon;
}

export function getChannelLogo(baseUrl: string): string {
  for (const [regex, logo] of URL_LOGO_MAP) {
    if (regex.test(baseUrl || "")) return logo;
  }
  return defaultIcon;
}

export const DefaultLogo = defaultIcon;
