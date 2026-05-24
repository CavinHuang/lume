
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getChannelsPath } from "../infra/config-paths";
import { fetchWithProxy } from "../infra/proxy-fetch";
import { decryptSecret, encryptSecret } from "../infra/secret-crypto";
import { getSuggestedProviderModels, normalizeChannelModel, PROVIDER_API_FAMILIES } from "@lume/shared";
import { parseModelRef } from "./model-selection";
import type {
  Channel,
  ChannelCreateInput,
  ChannelModel,
  ChannelsConfig,
  ChannelTestResult,
  ChannelUpdateInput,
  FetchModelsInput,
  FetchModelsResult,
  ProviderApiFamily
} from "@lume/shared";

const CONFIG_VERSION = 3;

function readConfig(): ChannelsConfig {
  const configPath = getChannelsPath();
  if (!existsSync(configPath)) return { version: CONFIG_VERSION, channels: [] };
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as ChannelsConfig;
    const normalized = normalizeChannelsConfig(parsed);
    if (normalized.changed) {
      writeConfig(normalized.config);
    }
    return normalized.config;
  } catch (error) {
    console.error("[渠道管理] 读取配置文件失败:", error);
    return { version: CONFIG_VERSION, channels: [] };
  }
}

function writeConfig(config: ChannelsConfig): void {
  const configPath = getChannelsPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

function normalizeProviderForStorage(provider: string): Channel["provider"] {
  if (provider === "zhipu") return "zai";
  if (provider === "qwen") return "qwen-portal";
  if (provider === "moonshot") return "kimi-coding";
  return provider as Channel["provider"];
}

function normalizeChannelsConfig(config: ChannelsConfig): { config: ChannelsConfig; changed: boolean } {
  let changed = false;
  const normalizedChannels = config.channels.map((channel) => {
    const normalizedProvider = normalizeProviderForStorage(channel.provider);
    const normalizedBaseUrl = channel.baseUrl.trim().replace(/\/+$/, "");
    const normalizedModels = channel.models.map((model) => {
      const normalizedModel = normalizeChannelModel({
        ...model,
        provider: normalizedProvider
      });
      if (
        normalizedModel.id !== model.id ||
        normalizedModel.name !== model.name ||
        normalizedProvider !== channel.provider ||
        normalizedBaseUrl !== channel.baseUrl ||
        model.alias !== normalizedModel.alias ||
        JSON.stringify(model.capabilities ?? {}) !== JSON.stringify(normalizedModel.capabilities ?? {})
      ) {
        changed = true;
      }
      return normalizedModel;
    });
    const normalizedDefaultModelId = channel.defaultModelId?.trim() || undefined;
    const normalizedFallbackModelIds = (channel.fallbackModelIds ?? [])
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    if (
      normalizedDefaultModelId !== channel.defaultModelId ||
      JSON.stringify(normalizedFallbackModelIds) !== JSON.stringify(channel.fallbackModelIds ?? [])
    ) {
      changed = true;
    }
    return {
      ...channel,
      provider: normalizedProvider,
      baseUrl: normalizedBaseUrl,
      models: normalizedModels,
      defaultModelId: normalizedDefaultModelId,
      fallbackModelIds: normalizedFallbackModelIds
    };
  });

  const normalizedVersion = Math.max(config.version ?? 1, CONFIG_VERSION);
  if (normalizedVersion !== config.version) {
    changed = true;
  }
  return {
    changed,
    config: {
      ...config,
      version: normalizedVersion,
      channels: normalizedChannels
    }
  };
}

export function listChannels(): Channel[] {
  return readConfig().channels;
}

export function getChannelById(id: string): Channel | undefined {
  return readConfig().channels.find((c) => c.id === id);
}

export function createChannel(input: ChannelCreateInput): Channel {
  const config = readConfig();
  const now = Date.now();
  const normalizedProvider = normalizeProviderForStorage(input.provider);
  const normalizedDefaultModelId = input.defaultModelId?.trim() || undefined;
  const normalizedFallbackModelIds = (input.fallbackModelIds ?? [])
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const channel: Channel = {
    id: randomUUID(),
    name: input.name,
    provider: normalizedProvider,
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
    apiKey: encryptSecret(input.apiKey),
    models: input.models.map((model) => normalizeChannelModel({ ...model, provider: normalizedProvider })),
    defaultModelId: normalizedDefaultModelId,
    fallbackModelIds: normalizedFallbackModelIds,
    enabled: input.enabled,
    createdAt: now,
    updatedAt: now
  };
  config.channels.push(channel);
  writeConfig(config);
  return channel;
}

export function updateChannel(id: string, input: ChannelUpdateInput): Channel {
  const config = readConfig();
  const idx = config.channels.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error(`渠道不存在: ${id}`);
  const existing = config.channels[idx] as Channel;
  const updated: Channel = {
    ...existing,
    ...input,
    ...(input.provider ? { provider: normalizeProviderForStorage(input.provider) } : {}),
    baseUrl: input.baseUrl ? input.baseUrl.trim().replace(/\/+$/, "") : existing.baseUrl,
    apiKey: input.apiKey ? encryptSecret(input.apiKey) : existing.apiKey,
    ...(input.models
      ? {
          models: input.models.map((model) => normalizeChannelModel({
            ...model,
            provider: input.provider ? normalizeProviderForStorage(input.provider) : existing.provider
          }))
        }
      : {}),
    ...(input.defaultModelId !== undefined
      ? { defaultModelId: input.defaultModelId.trim() || undefined }
      : {}),
    ...(input.fallbackModelIds !== undefined
      ? {
          fallbackModelIds: input.fallbackModelIds
            .map((id) => id.trim())
            .filter((id) => id.length > 0)
        }
      : {}),
    updatedAt: Date.now()
  };
  config.channels[idx] = updated;
  writeConfig(config);
  return updated;
}

export function deleteChannel(id: string): void {
  const config = readConfig();
  const idx = config.channels.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error(`渠道不存在: ${id}`);
  config.channels.splice(idx, 1);
  writeConfig(config);
}

export function decryptApiKey(channelId: string): string {
  const channel = getChannelById(channelId);
  if (!channel) throw new Error(`渠道不存在: ${channelId}`);
  return decryptSecret(channel.apiKey);
}

export function resolveChannelEmbeddingBinding(modelRef: string): {
  channel: Channel;
  modelId: string;
  apiKey: string;
  family: ProviderApiFamily;
} | null {
  const parsed = parseModelRef(modelRef, "");
  if (!parsed) {
    return null;
  }

  const channel = listChannels().find((item) => {
    if (!item.enabled || item.provider !== parsed.provider) {
      return false;
    }
    return item.models.some((model) =>
      model.id === parsed.model &&
      model.enabled &&
      model.capabilities?.embedding === true
    );
  });

  if (!channel) {
    return null;
  }

  return {
    channel,
    modelId: parsed.model,
    apiKey: decryptSecret(channel.apiKey),
    family: resolveProviderApiFamily(channel.provider, channel.baseUrl)
  };
}

export function resolveChannelModelBinding(
  modelRef: string,
  capability?: "chat" | "embedding"
): {
  channel: Channel;
  modelId: string;
  family: ProviderApiFamily;
} | null {
  const parsed = parseModelRef(modelRef, "");
  if (!parsed) {
    return null;
  }

  const channel = listChannels().find((item) => {
    if (!item.enabled || item.provider !== parsed.provider) {
      return false;
    }
    return item.models.some((model) => {
      if (!model.enabled || model.id !== parsed.model) {
        return false;
      }
      if (!capability) {
        return true;
      }
      return model.capabilities?.[capability] === true;
    });
  });

  if (!channel) {
    return null;
  }

  return {
    channel,
    modelId: parsed.model,
    family: resolveProviderApiFamily(channel.provider, channel.baseUrl)
  };
}

function normalizeAnthropicBaseUrl(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, "");
  if (!url.match(/\/v\d+$/)) url = `${url}/v1`;
  return url;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function authorizationHeaders(apiKey: string): Record<string, string> {
  const trimmed = apiKey.trim();
  return trimmed ? { Authorization: `Bearer ${trimmed}` } : {};
}

function resolveProviderApiFamily(provider: Channel["provider"], baseUrl: string): ProviderApiFamily {
  const normalizedBaseUrl = baseUrl.trim().toLowerCase();
  const byProvider = PROVIDER_API_FAMILIES[provider];
  if (normalizedBaseUrl.includes("/anthropic")) {
    return "anthropic";
  }
  return byProvider;
}

async function testAnthropic(baseUrl: string, apiKey: string): Promise<ChannelTestResult> {
  const url = normalizeAnthropicBaseUrl(baseUrl);
  const response = await fetchWithProxy(`${url}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      Authorization: `Bearer ${apiKey}`,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }]
    })
  });
  if (response.ok) return { success: true, message: "连接成功" };
  if (response.status === 401) return { success: false, message: "API Key 无效" };
  return { success: false, message: `请求失败 (${response.status})` };
}

async function testOpenAICompatible(baseUrl: string, apiKey: string): Promise<ChannelTestResult> {
  const url = normalizeBaseUrl(baseUrl);
  const response = await fetchWithProxy(`${url}/models`, {
    method: "GET",
    headers: authorizationHeaders(apiKey)
  });
  if (response.ok) return { success: true, message: "连接成功" };
  if (response.status === 401) return { success: false, message: "API Key 无效" };
  return { success: false, message: `请求失败 (${response.status})` };
}

async function testJina(baseUrl: string, apiKey: string): Promise<ChannelTestResult> {
  const url = normalizeBaseUrl(baseUrl);
  const candidateModels = [
    "jina-embeddings-v5-text-small",
    "jina-embeddings-v5-text-nano",
    "jina-embeddings-v4",
    "jina-embeddings-v3"
  ];

  let lastStatus = 0;
  let lastDetail = "";

  for (const model of candidateModels) {
    const response = await fetchWithProxy(`${url}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        input: [
          "hello lume",
          "test embedding request"
        ]
      })
    });

    if (response.ok) {
      return { success: true, message: `连接成功 (${model})` };
    }

    lastStatus = response.status;
    lastDetail = await response.text().catch(() => "");
    if (response.status === 401) {
      return { success: false, message: "API Key 无效" };
    }
  }

  const detail = lastDetail.trim().replace(/\s+/g, " ").slice(0, 160);
  return {
    success: false,
    message: detail
      ? `请求失败 (${lastStatus}): ${detail}`
      : `请求失败 (${lastStatus})`
  };
}

async function testGoogle(baseUrl: string, apiKey: string): Promise<ChannelTestResult> {
  const url = normalizeBaseUrl(baseUrl);
  const response = await fetchWithProxy(`${url}/v1beta/models?key=${apiKey}`, { method: "GET" });
  if (response.ok) return { success: true, message: "连接成功" };
  if (response.status === 400 || response.status === 403) return { success: false, message: "API Key 无效" };
  return { success: false, message: `请求失败 (${response.status})` };
}

export async function testChannel(channelId: string): Promise<ChannelTestResult> {
  const channel = getChannelById(channelId);
  if (!channel) return { success: false, message: "渠道不存在" };
  const apiKey = decryptSecret(channel.apiKey);
  if (channel.provider === "jina") return testJina(channel.baseUrl, apiKey);
  const family = resolveProviderApiFamily(channel.provider, channel.baseUrl);
  if (family === "anthropic") return testAnthropic(channel.baseUrl, apiKey);
  if (family === "google") return testGoogle(channel.baseUrl, apiKey);
  return testOpenAICompatible(channel.baseUrl, apiKey);
}

export async function testChannelDirect(input: FetchModelsInput): Promise<ChannelTestResult> {
  if (input.provider === "jina") return testJina(input.baseUrl, input.apiKey);
  const family = resolveProviderApiFamily(input.provider, input.baseUrl);
  if (family === "anthropic") return testAnthropic(input.baseUrl, input.apiKey);
  if (family === "google") return testGoogle(input.baseUrl, input.apiKey);
  return testOpenAICompatible(input.baseUrl, input.apiKey);
}

interface OpenAIModelItem {
  id: string;
}

interface AnthropicModelItem {
  id: string;
  display_name?: string;
}

interface GoogleModelItem {
  name: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
}

async function fetchOpenAICompatibleModels(
  provider: Channel["provider"],
  baseUrl: string,
  apiKey: string
): Promise<FetchModelsResult> {
  const url = normalizeBaseUrl(baseUrl);
  const response = await fetchWithProxy(`${url}/models`, { headers: authorizationHeaders(apiKey) });
  if (!response.ok) {
    const suggested = getSuggestedProviderModels(provider);
    if (provider === "jina" && suggested.length > 0) {
      return {
        success: true,
        message: `Jina 模型列表接口不可用，已回退到 ${suggested.length} 个推荐模型`,
        models: suggested
      };
    }
    return { success: false, message: `请求失败 (${response.status})`, models: [] };
  }
  const data = (await response.json()) as { data?: OpenAIModelItem[] };
  const models: ChannelModel[] = (data.data ?? []).map((item) => normalizeChannelModel({
    id: item.id,
    name: item.id,
    enabled: true,
    provider
  }));
  if (provider === "jina" && models.length === 0) {
    const suggested = getSuggestedProviderModels(provider);
    if (suggested.length > 0) {
      return {
        success: true,
        message: `Jina 返回空模型列表，已回退到 ${suggested.length} 个推荐模型`,
        models: suggested
      };
    }
  }
  return { success: true, message: `成功获取 ${models.length} 个模型`, models };
}

async function fetchAnthropicModels(baseUrl: string, apiKey: string): Promise<FetchModelsResult> {
  const url = normalizeAnthropicBaseUrl(baseUrl);
  const response = await fetchWithProxy(`${url}/models`, {
    headers: {
      "x-api-key": apiKey,
      Authorization: `Bearer ${apiKey}`,
      "anthropic-version": "2023-06-01"
    }
  });
  if (!response.ok) return { success: false, message: `请求失败 (${response.status})`, models: [] };
  const data = (await response.json()) as { data?: AnthropicModelItem[] };
  const models: ChannelModel[] = (data.data ?? []).map((item) => ({
    ...normalizeChannelModel({
      id: item.id,
      name: item.display_name ?? item.id,
      enabled: true,
      provider: "anthropic"
    })
  }));
  return { success: true, message: `成功获取 ${models.length} 个模型`, models };
}

async function fetchGoogleModels(baseUrl: string, apiKey: string): Promise<FetchModelsResult> {
  const url = normalizeBaseUrl(baseUrl);
  const response = await fetchWithProxy(`${url}/v1beta/models?key=${apiKey}`);
  if (!response.ok) return { success: false, message: `请求失败 (${response.status})`, models: [] };
  const data = (await response.json()) as { models?: GoogleModelItem[] };
  const models: ChannelModel[] = (data.models ?? [])
    .map((item) => {
      const id = item.name.replace(/^models\//, "");
      return normalizeChannelModel({
        id,
        name: item.displayName ?? id,
        enabled: true,
        provider: "google",
        supportedGenerationMethods: item.supportedGenerationMethods
      });
    });
  return { success: true, message: `成功获取 ${models.length} 个模型`, models };
}

export async function fetchModels(input: FetchModelsInput): Promise<FetchModelsResult> {
  const family = resolveProviderApiFamily(input.provider, input.baseUrl);
  if (family === "anthropic") return fetchAnthropicModels(input.baseUrl, input.apiKey);
  if (family === "google") return fetchGoogleModels(input.baseUrl, input.apiKey);
  return fetchOpenAICompatibleModels(input.provider, input.baseUrl, input.apiKey);
}
