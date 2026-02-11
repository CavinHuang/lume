import type { ProviderType } from "@lume/shared";

const MODEL = {
  default: "/models/default.png",
  claude: "/models/claude.png",
  openai: "/models/openai.png",
  gpt4: "/models/gpt_4.png",
  gpt35: "/models/gpt_3.5.png",
  gpto1: "/models/gpt_o1.png",
  gptImage: "/models/gpt_image_1.png",
  gpt5: "/models/gpt-5.png",
  gpt5Chat: "/models/gpt-5-chat.png",
  gpt5Mini: "/models/gpt-5-mini.png",
  gpt5Nano: "/models/gpt-5-nano.png",
  gpt5Codex: "/models/gpt-5-codex.png",
  gpt51: "/models/gpt-5.1.png",
  gpt51Chat: "/models/gpt-5.1-chat.png",
  gpt51Codex: "/models/gpt-5.1-codex.png",
  gpt51CodexMini: "/models/gpt-5.1-codex-mini.png",
  deepseek: "/models/deepseek.png",
  gemini: "/models/gemini.png",
  gemma: "/models/gemma.png",
  deepgemini: "/models/deepgemini.png",
  kimigemini: "/models/kimigemini.png",
  qwengemini: "/models/qwengemini.png",
  seedgemini: "/models/seedgemini.png",
  qwen: "/models/qwen.png",
  grok: "/models/grok.png",
  moonshot: "/models/moonshot.png",
  doubao: "/models/doubao.png",
  zhipu: "/models/zhipu.png",
  chatglm: "/models/chatglm.png",
  llama: "/models/llama.png",
  mixtral: "/models/mixtral.png",
  codestral: "/models/codestral.png",
  yi: "/models/yi.png",
  hunyuan: "/models/hunyuan.png",
  wenxin: "/models/wenxin.png",
  sparkdesk: "/models/sparkdesk.png",
  step: "/models/step.png",
  minimax: "/models/minimax.png",
  proma: "/models/proma.png",
  cohere: "/models/cohere.png",
  embedding: "/models/embedding.png"
} as const;

const MODEL_LOGO_MAP: Record<string, string> = {
  "gpt-image": MODEL.gptImage,
  "gpt-3": MODEL.gpt35,
  "gpt-4": MODEL.gpt4,
  o1: MODEL.gpto1,
  o3: MODEL.gpto1,
  o4: MODEL.gpto1,
  "gpt-5-mini": MODEL.gpt5Mini,
  "gpt-5-nano": MODEL.gpt5Nano,
  "gpt-5-chat": MODEL.gpt5Chat,
  "gpt-5-codex": MODEL.gpt5Codex,
  "gpt-5\\.1-codex-mini": MODEL.gpt51CodexMini,
  "gpt-5\\.1-codex": MODEL.gpt51Codex,
  "gpt-5\\.1-chat": MODEL.gpt51Chat,
  "gpt-5\\.1": MODEL.gpt51,
  "gpt-5": MODEL.gpt5,
  gpts: MODEL.gpt4,
  "(claude|anthropic-)": MODEL.claude,
  deepseek: MODEL.deepseek,
  deepgemini: MODEL.deepgemini,
  kimigemini: MODEL.kimigemini,
  qwengemini: MODEL.qwengemini,
  seedgemini: MODEL.seedgemini,
  veo: MODEL.gemini,
  gemma: MODEL.gemma,
  gemini: MODEL.gemini,
  "(qwen|qwq|qvq|wan-)": MODEL.qwen,
  grok: MODEL.grok,
  moonshot: MODEL.moonshot,
  kimi: MODEL.moonshot,
  doubao: MODEL.doubao,
  "ep-202": MODEL.doubao,
  zhipu: MODEL.zhipu,
  cogview: MODEL.zhipu,
  glm: MODEL.chatglm,
  llama: MODEL.llama,
  codestral: MODEL.codestral,
  mixtral: MODEL.mixtral,
  mistral: MODEL.mixtral,
  ministral: MODEL.mixtral,
  magistral: MODEL.mixtral,
  "yi-": MODEL.yi,
  "ernie-": MODEL.wenxin,
  "tao-": MODEL.wenxin,
  hunyuan: MODEL.hunyuan,
  sparkdesk: MODEL.sparkdesk,
  generalv: MODEL.sparkdesk,
  step: MODEL.step,
  minimax: MODEL.minimax,
  cohere: MODEL.cohere,
  command: MODEL.cohere,
  "text-embedding": MODEL.embedding,
  embedding: MODEL.embedding
};

const PROVIDER_LOGO_MAP: Record<ProviderType, string> = {
  anthropic: MODEL.claude,
  openai: MODEL.openai,
  deepseek: MODEL.deepseek,
  google: MODEL.gemini,
  moonshot: MODEL.moonshot,
  zhipu: MODEL.zhipu,
  minimax: MODEL.minimax,
  doubao: MODEL.doubao,
  qwen: MODEL.qwen,
  custom: MODEL.default
};

const URL_LOGO_MAP: Array<[RegExp, string]> = [
  [/proma\.cool/i, MODEL.proma],
  [/moonshot\.cn|kimi/i, MODEL.moonshot],
  [/bigmodel\.cn|zhipuai/i, MODEL.zhipu],
  [/minimax/i, MODEL.minimax],
  [/volces\.com|volcengine/i, MODEL.doubao],
  [/dashscope|aliyuncs/i, MODEL.qwen],
  [/deepseek/i, MODEL.deepseek],
  [/anthropic/i, MODEL.claude],
  [/openai\.com/i, MODEL.openai],
  [/googleapis|generativelanguage/i, MODEL.gemini],
  [/grok|x\.ai/i, MODEL.grok],
  [/stepfun/i, MODEL.step],
  [/cohere/i, MODEL.cohere],
  [/spark-api|xfyun/i, MODEL.sparkdesk],
  [/hunyuan/i, MODEL.hunyuan],
  [/ernie|baidu/i, MODEL.wenxin],
  [/yi\.com|lingyiwanwu/i, MODEL.yi]
];

export function getModelLogoById(modelId: string): string | undefined {
  if (!modelId) return undefined;
  for (const key in MODEL_LOGO_MAP) {
    if (new RegExp(key, "i").test(modelId)) return MODEL_LOGO_MAP[key];
  }
  return undefined;
}

export function getModelLogo(modelId: string, provider?: ProviderType): string {
  return getModelLogoById(modelId) ?? (provider ? PROVIDER_LOGO_MAP[provider] : undefined) ?? MODEL.default;
}

export function getProviderLogo(provider: ProviderType): string {
  return PROVIDER_LOGO_MAP[provider] ?? MODEL.default;
}

export function getChannelLogo(baseUrl: string): string {
  for (const [regex, logo] of URL_LOGO_MAP) {
    if (regex.test(baseUrl || "")) return logo;
  }
  return MODEL.default;
}

export const DefaultLogo = MODEL.default;
export const PromaLogo = MODEL.proma;
