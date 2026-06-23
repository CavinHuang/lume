import type { ProviderType } from "@lume/shared";
import type { KnownProvider } from "./model-types";

const PROVIDER_ALIAS: Record<string, KnownProvider | null> = {
  anthropic: "anthropic",
  "anthropic-compatible": "anthropic",
  openai: "openai",
  jina: "openai",
  openrouter: "openrouter",
  opencode: "opencode",
  google: "google",
  gemini: "google",
  deepseek: "openai",
  moonshot: "openai",
  "z.ai": "zai",
  "z-ai": "zai",
  zhipu: "zai",
  zai: "zai",
  "zai-coding-plan": "zai",
  minimax: "minimax",
  "minimax-cn": "minimax-cn",
  doubao: "openai",
  qwen: "openai",
  "qwen-portal": "openai",
  ollama: "openai",
  lmstudio: "openai",
  custom: "openai",
  kimi: "kimi-coding",
  "kimi-code": "kimi-coding",
  "kimi-coding": "kimi-coding",
  siliconflow: "openai",
  "aliyun-coding-plan": "openai",
  "volcengine-coding-plan": "openai",
  "xiaomi-token-plan": "openai",
  stepfun: "openai",
  "stepfun-coding-plan": "openai",
  "minimax-token-plan": "anthropic"
};

function normalizeProviderToken(raw?: string): string {
  return (raw ?? "").trim().toLowerCase();
}

export function mapLumeProviderToRuntimeProvider(provider?: ProviderType | string): KnownProvider | null {
  const normalized = normalizeProviderToken(provider);
  if (!normalized) return null;
  return PROVIDER_ALIAS[normalized] ?? null;
}

export function parseProviderModelRef(rawModelId: string): { provider: KnownProvider; model: string } | null {
  const trimmed = rawModelId.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0) {
    return null;
  }
  const providerToken = trimmed.slice(0, slashIndex).trim();
  const model = trimmed.slice(slashIndex + 1).trim();
  const provider = mapLumeProviderToRuntimeProvider(providerToken);
  if (!provider || !model) {
    return null;
  }
  return { provider, model };
}

function inferRuntimeProviderFromModel(modelId: string): KnownProvider | null {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith("claude")) return "anthropic";
  if (normalized.startsWith("gemini")) return "google";
  if (normalized.startsWith("glm-")) return "zai";
  if (normalized.startsWith("minimax")) return "minimax";
  if (normalized.startsWith("gpt-")) return "openai";
  if (normalized.startsWith("deepseek")) return "openai";
  if (normalized.startsWith("qwen")) return "openai";
  return null;
}

function inferRuntimeProviderFromBaseUrl(baseUrl?: string): KnownProvider | null {
  const normalized = (baseUrl ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("/anthropic")) return "anthropic";
  if (normalized.includes("api.anthropic.com")) return "anthropic";
  if (normalized.includes("generativelanguage.googleapis.com")) return "google";
  if (normalized.includes("openrouter.ai")) return "openrouter";
  if (normalized.includes("open.bigmodel.cn") || normalized.includes("bigmodel.cn")) return "zai";
  if (normalized.includes("minimax")) return "minimax";
  if (normalized.includes("dashscope.aliyuncs.com")) return "openai";
  if (normalized.includes("ark.cn-beijing.volces.com")) return "openai";
  if (normalized.includes("api.deepseek.com")) return "openai";
  if (normalized.includes("api.moonshot.cn")) return "openai";
  if (normalized.includes("api.openai.com")) return "openai";
  return null;
}

function pushUnique(list: KnownProvider[], provider: KnownProvider | null): void {
  if (!provider) return;
  if (!list.includes(provider)) {
    list.push(provider);
  }
}

export function resolveRuntimeProviderCandidates(params: {
  channelProvider?: ProviderType | string;
  modelId: string;
  baseUrl?: string;
}): { modelId: string; candidates: KnownProvider[] } {
  const parsedRef = parseProviderModelRef(params.modelId);
  const normalizedModelId = parsedRef?.model ?? params.modelId.trim();
  const candidates: KnownProvider[] = [];
  const channelProviderToken = normalizeProviderToken(params.channelProvider);
  const mappedChannelProvider = mapLumeProviderToRuntimeProvider(params.channelProvider);

  pushUnique(candidates, parsedRef?.provider ?? null);
  if (channelProviderToken !== "custom") {
    pushUnique(candidates, mappedChannelProvider);
  }
  pushUnique(candidates, inferRuntimeProviderFromBaseUrl(params.baseUrl));
  pushUnique(candidates, inferRuntimeProviderFromModel(normalizedModelId));
  pushUnique(candidates, mappedChannelProvider);
  pushUnique(candidates, "openai");

  return {
    modelId: normalizedModelId,
    candidates
  };
}
