import type { ProviderType } from "@lume/shared";
import type { KnownProvider } from "@mariozechner/pi-ai";

const PROVIDER_ALIAS: Record<string, KnownProvider | null> = {
  anthropic: "anthropic",
  openai: "openai",
  openrouter: "openrouter",
  opencode: "opencode",
  google: "google",
  gemini: "google",
  deepseek: "openai",
  moonshot: "openai",
  zhipu: "zai",
  "z.ai": "zai",
  "z-ai": "zai",
  zai: "zai",
  minimax: "minimax",
  "minimax-cn": "minimax-cn",
  doubao: "openai",
  qwen: "openai",
  "qwen-portal": "openai",
  custom: "openai",
  kimi: "kimi-coding",
  "kimi-code": "kimi-coding",
  "kimi-coding": "kimi-coding"
};

function normalizeProviderToken(raw?: string): string {
  return (raw ?? "").trim().toLowerCase();
}

export function mapLumeProviderToPiProvider(provider?: ProviderType | string): KnownProvider | null {
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
  const provider = mapLumeProviderToPiProvider(providerToken);
  if (!provider || !model) {
    return null;
  }
  return { provider, model };
}

function inferPiProviderFromModel(modelId: string): KnownProvider | null {
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

function inferPiProviderFromBaseUrl(baseUrl?: string): KnownProvider | null {
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

export function resolvePiProviderCandidates(params: {
  channelProvider?: ProviderType | string;
  modelId: string;
  baseUrl?: string;
}): { modelId: string; candidates: KnownProvider[] } {
  const parsedRef = parseProviderModelRef(params.modelId);
  const normalizedModelId = parsedRef?.model ?? params.modelId.trim();
  const candidates: KnownProvider[] = [];
  const channelProviderToken = normalizeProviderToken(params.channelProvider);
  const mappedChannelProvider = mapLumeProviderToPiProvider(params.channelProvider);

  pushUnique(candidates, parsedRef?.provider ?? null);
  if (channelProviderToken !== "custom") {
    pushUnique(candidates, mappedChannelProvider);
  }
  pushUnique(candidates, inferPiProviderFromBaseUrl(params.baseUrl));
  pushUnique(candidates, inferPiProviderFromModel(normalizedModelId));
  pushUnique(candidates, mappedChannelProvider);
  pushUnique(candidates, "openai");

  return {
    modelId: normalizedModelId,
    candidates
  };
}
