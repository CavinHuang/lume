
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { getChannelsPath } from "../infra/config-paths";
import { fetchWithProxy } from "../infra/proxy-fetch";
import { decryptSecret } from "../infra/secret-crypto";
import {
  deleteConnectionCredentials,
  deleteConnectionOAuthCredential,
  getConnectionApiKey,
  hasConnectionApiKey,
  hasConnectionOAuthCredential,
  isConnectionVaultUnlocked,
  setConnectionApiKey,
} from "./connection-credential-store";
import { getSuggestedProviderModels, normalizeChannelModel, parseConnectionModelRef, PROVIDER_API_FAMILIES } from "@lume/shared";
import { parseModelRef } from "./model-selection";
import { createLogger } from "../infra/logger";
import { withIndexMutationLock } from "../infra/index-mutation-lock";
import type {
  Channel,
  ChannelCreateInput,
  ChannelModel,
  ChannelsConfig,
  ChannelTestResult,
  ChannelUpdateInput,
  FetchModelsInput,
  FetchModelsResult,
  ProviderApiFamily,
  ConnectionProtocol,
  SyncChannelModelsResult
} from "@lume/shared";

const CONFIG_VERSION = 4;
const CONNECTION_REQUEST_TIMEOUT_MS = 20_000;
const log = createLogger("channel-manager");

function fetchConnection(input: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithProxy(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(CONNECTION_REQUEST_TIMEOUT_MS),
  });
}

// ---------------------------------------------------------------------------
// 配置读写与并发控制（#159）
//
// readConfig 是热路径（listChannels 被每次模型解析调用），保持无锁快读；
// 仅当归一化需要回写时才拿锁做 RMW（锁内重读，避免覆盖并发写入）。
// create/update/delete 全程持锁（withIndexMutationLock 非重入：锁内一律走
// readConfigUnlocked/writeConfigUnlocked，禁止再调公开版）。testChannel 的网络部分
// 在锁外，仅最终 health 字段写回经公开 updateChannel 进锁，并发编辑天然保留。
// ---------------------------------------------------------------------------
function channelsLockPath(): string {
  return `${getChannelsPath()}.lock`;
}

function readConfigUnlocked(): { config: ChannelsConfig; changed: boolean } {
  const configPath = getChannelsPath();
  if (!existsSync(configPath)) return { config: { version: CONFIG_VERSION, channels: [] }, changed: false };
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as ChannelsConfig;
    const normalized = normalizeChannelsConfig(parsed);
    return { config: normalized.config, changed: normalized.changed };
  } catch (error) {
    log.error("failed to read channel configuration", { error });
    return { config: { version: CONFIG_VERSION, channels: [] }, changed: false };
  }
}

function writeConfigUnlocked(config: ChannelsConfig): void {
  const configPath = getChannelsPath();
  const temporary = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2), { encoding: "utf-8", flag: "wx" });
  renameSync(temporary, configPath);
}

function readConfig(): ChannelsConfig {
  const unlocked = readConfigUnlocked();
  if (!unlocked.changed) return unlocked.config;
  return withIndexMutationLock(channelsLockPath(), () => {
    const latest = readConfigUnlocked();
    if (latest.changed) {
      writeConfigUnlocked(latest.config);
    }
    return latest.config;
  });
}

/** 持锁 read-modify-write；action 内通过 writeConfigUnlocked 写回。 */
function mutateConfig<T>(action: (config: ChannelsConfig) => T): T {
  return withIndexMutationLock(channelsLockPath(), () => {
    return action(readConfigUnlocked().config);
  });
}

function normalizeProviderForStorage(provider: string): Channel["provider"] {
  if (provider === "zhipu") return "zai";
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
        source: model.source ?? "manual",
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
    let legacyApiKey = channel.apiKey;
    if (legacyApiKey && isConnectionVaultUnlocked() && !hasConnectionApiKey(channel.id)) {
      try {
        const plain = decryptSecret(legacyApiKey);
        setConnectionApiKey(channel.id, plain);
        legacyApiKey = "";
        changed = true;
      } catch (error) {
        log.warn("failed to migrate legacy connection credential", {
          channelId: channel.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      ...channel,
      provider: normalizedProvider,
      protocol: channel.protocol ?? resolveConnectionProtocol(
        normalizedProvider,
        normalizedBaseUrl,
        channel.apiFamily,
        channel.openaiApiMode
      ),
      authType: channel.authType ?? (legacyApiKey || hasConnectionApiKey(channel.id) ? "api-key" : "none"),
      baseUrl: normalizedBaseUrl,
      models: normalizedModels,
      apiKey: legacyApiKey,
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
  return readConfig().channels.map(toChannelView);
}

export function getChannelById(id: string): Channel | undefined {
  return readConfig().channels.find((c) => c.id === id);
}

export function isChannelConnectionUsable(channel: Channel): boolean {
  if (!channel.enabled) return false;
  if (channel.authType === "oauth") return hasConnectionOAuthCredential(channel.id);
  if (channel.authType === "api-key") {
    return hasConnectionApiKey(channel.id) || Boolean(channel.apiKey);
  }
  return channel.provider === "ollama" || channel.provider === "lmstudio";
}

export function createChannel(input: ChannelCreateInput): Channel {
  return mutateConfig((config) => {
    const now = Date.now();
    const normalizedProvider = normalizeProviderForStorage(input.provider);
    const normalizedDefaultModelId = input.defaultModelId?.trim() || undefined;
    const normalizedFallbackModelIds = (input.fallbackModelIds ?? [])
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    const id = randomUUID();
    if (input.apiKey.trim()) setConnectionApiKey(id, input.apiKey);
    const channel: Channel = {
      id,
      name: input.name,
      provider: normalizedProvider,
      protocol: input.protocol ?? resolveConnectionProtocol(
        normalizedProvider,
        input.baseUrl,
        input.apiFamily,
        input.openaiApiMode,
      ),
      authType: input.apiKey.trim() ? "api-key" : (input.authType ?? "none"),
      ...(input.accountLabel?.trim() ? { accountLabel: input.accountLabel.trim() } : {}),
      baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
      apiKey: "",
      models: input.models.map((model) => normalizeChannelModel({
        ...model,
        source: model.source ?? "manual",
        provider: normalizedProvider
      })),
      defaultModelId: normalizedDefaultModelId,
      fallbackModelIds: normalizedFallbackModelIds,
      enabled: input.enabled,
      createdAt: now,
      updatedAt: now,
      ...(input.apiFamily ? { apiFamily: input.apiFamily } : {}),
      ...(input.openaiApiMode ? { openaiApiMode: input.openaiApiMode } : {}),
      ...(input.providerId ? { providerId: input.providerId } : {}),
    };
    config.channels.push(channel);
    writeConfigUnlocked(config);
    return toChannelView(channel);
  });
}

export function updateChannel(id: string, input: ChannelUpdateInput): Channel {
  return mutateConfig((config) => {
    const idx = config.channels.findIndex((c) => c.id === id);
    if (idx === -1) throw new Error(`渠道不存在: ${id}`);
    const existing = config.channels[idx] as Channel;
    const provider = input.provider ? normalizeProviderForStorage(input.provider) : existing.provider;
    const oauthProviderChanged = provider !== existing.provider && existing.authType === "oauth";
    const connectionChanged = input.provider !== undefined
      || input.baseUrl !== undefined
      || input.apiKey !== undefined
      || input.authType !== undefined
      || input.apiFamily !== undefined
      || input.openaiApiMode !== undefined
      || input.providerId !== undefined;
    if (input.apiKey?.trim()) {
      setConnectionApiKey(id, input.apiKey);
      deleteConnectionOAuthCredential(id);
    } else if (input.authType === "none" || oauthProviderChanged) {
      deleteConnectionCredentials(id);
    }
    const protocol = input.protocol ?? (
      input.provider !== undefined
        || input.baseUrl !== undefined
        || input.apiFamily !== undefined
        || input.openaiApiMode !== undefined
        ? resolveConnectionProtocol(
          provider,
          input.baseUrl ?? existing.baseUrl,
          input.apiFamily ?? existing.apiFamily,
          input.openaiApiMode ?? existing.openaiApiMode,
        )
        : existing.protocol
    );
    const updated: Channel = {
      ...existing,
      ...input,
      provider,
      protocol,
      ...(input.accountLabel !== undefined ? { accountLabel: input.accountLabel.trim() || undefined } : {}),
      ...(input.apiKey?.trim() ? { authType: "api-key" as const, accountLabel: undefined } : {}),
      ...(input.authType === "none" ? { accountLabel: undefined } : {}),
      ...(oauthProviderChanged && !input.apiKey?.trim()
        ? { authType: "none" as const, accountLabel: undefined }
        : {}),
      ...(connectionChanged
        ? { healthStatus: "unknown" as const, healthMessage: undefined, lastTestedAt: undefined }
        : {}),
      baseUrl: input.baseUrl ? input.baseUrl.trim().replace(/\/+$/, "") : existing.baseUrl,
      apiKey: input.apiKey?.trim() ? "" : existing.apiKey,
      ...(input.models
        ? {
            models: input.models.map((model) => normalizeChannelModel({
              ...model,
              source: model.source ?? "manual",
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
      ...(input.apiFamily !== undefined ? { apiFamily: input.apiFamily } : {}),
      updatedAt: Date.now()
    };
    config.channels[idx] = updated;
    writeConfigUnlocked(config);
    return toChannelView(updated);
  });
}

export function deleteChannel(id: string): void {
  mutateConfig((config) => {
    const idx = config.channels.findIndex((c) => c.id === id);
    if (idx === -1) throw new Error(`渠道不存在: ${id}`);
    config.channels.splice(idx, 1);
    writeConfigUnlocked(config);
    deleteConnectionCredentials(id);
  });
}

export function decryptApiKey(channelId: string): string {
  const channel = getChannelById(channelId);
  if (!channel) throw new Error(`渠道不存在: ${channelId}`);
  if (hasConnectionApiKey(channelId)) return getConnectionApiKey(channelId);
  return channel.apiKey ? decryptSecret(channel.apiKey) : "";
}

function toChannelView(channel: Channel): Channel {
  return {
    ...channel,
    apiKey: "",
    hasApiKey: hasConnectionApiKey(channel.id) || Boolean(channel.apiKey),
    hasOAuthCredential: hasConnectionOAuthCredential(channel.id),
  };
}

export function resolveChannelEmbeddingBinding(modelRef: string): {
  channel: Channel;
  modelId: string;
  apiKey: string;
  family: ProviderApiFamily;
} | null {
  const binding = resolveChannelModelBinding(modelRef, "embedding");
  if (!binding) return null;

  return {
    channel: binding.channel,
    modelId: binding.modelId,
    apiKey: decryptApiKey(binding.channel.id),
    family: binding.family,
  };
}

export function resolveChannelModelBinding(
  modelRef: string,
  capability?: "chat" | "embedding",
  preferredConnectionId?: string,
): {
  channel: Channel;
  modelId: string;
  family: ProviderApiFamily;
} | null {
  const scoped = parseConnectionModelRef(modelRef);
  if (scoped) {
    const channel = listChannels().find((item) => (
      item.id === scoped.connectionId && isChannelConnectionUsable(item)
    ));
    const model = channel?.models.find((item) => item.id === scoped.modelId && item.enabled);
    if (!channel || !model || (capability && model.capabilities?.[capability] !== true)) return null;
    return {
      channel,
      modelId: scoped.modelId,
      family: resolveProviderApiFamily(channel.provider, channel.baseUrl, channel.apiFamily),
    };
  }
  const normalizedRef = modelRef.trim();
  if (preferredConnectionId && normalizedRef) {
    const channel = listChannels().find((item) => (
      item.id === preferredConnectionId && isChannelConnectionUsable(item)
    ));
    const effectiveProvider = channel?.providerId ?? channel?.provider;
    const model = channel?.models.find((item) => (
      item.enabled
      && (!capability || item.capabilities?.[capability] === true)
      && (
        item.id === normalizedRef
        || `${effectiveProvider}/${item.id}` === normalizedRef
        || `${channel.id}/${item.id}` === normalizedRef
      )
    ));
    if (channel && model) {
      return {
        channel,
        modelId: model.id,
        family: resolveProviderApiFamily(channel.provider, channel.baseUrl, channel.apiFamily),
      };
    }
  }
  const parsed = parseModelRef(modelRef, "");
  if (!parsed) {
    return null;
  }

  const matchingChannels = listChannels().filter((item) => {
    const effectiveProvider = item.providerId ?? item.provider;
    if (!isChannelConnectionUsable(item) || effectiveProvider !== parsed.provider) {
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

  if (matchingChannels.length !== 1) {
    return null;
  }
  const channel = matchingChannels[0]!;

  return {
    channel,
    modelId: parsed.model,
    family: resolveProviderApiFamily(channel.provider, channel.baseUrl, channel.apiFamily)
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

function resolveProviderApiFamily(
  provider: Channel["provider"],
  baseUrl: string,
  apiFamily?: ProviderApiFamily
): ProviderApiFamily {
  // 自定义渠道优先使用显式声明的 apiFamily
  if (provider === "custom" && apiFamily) {
    return apiFamily;
  }
  const normalizedBaseUrl = baseUrl.trim().toLowerCase();
  const byProvider = PROVIDER_API_FAMILIES[provider];
  if (normalizedBaseUrl.includes("/anthropic")) {
    return "anthropic";
  }
  return byProvider;
}

function resolveConnectionProtocol(
  provider: Channel["provider"],
  baseUrl: string,
  apiFamily?: ProviderApiFamily,
  openaiApiMode?: Channel["openaiApiMode"]
): ConnectionProtocol {
  const family = resolveProviderApiFamily(provider, baseUrl, apiFamily);
  if (family === "anthropic") return "anthropic-messages";
  if (family === "google") return "google-generative-ai";
  return openaiApiMode === "responses" ? "openai-responses" : "openai-completions";
}

async function testAnthropic(baseUrl: string, apiKey: string): Promise<ChannelTestResult> {
  const url = normalizeAnthropicBaseUrl(baseUrl);
  const response = await fetchConnection(`${url}/models?limit=1`, {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      Authorization: `Bearer ${apiKey}`,
      "anthropic-version": "2023-06-01"
    }
  });
  if (response.ok) return { success: true, message: "连接成功" };
  if (response.status === 401) return { success: false, message: "API Key 无效" };
  return { success: false, message: `请求失败 (${response.status})` };
}

async function testOpenAICompatible(baseUrl: string, apiKey: string): Promise<ChannelTestResult> {
  const url = normalizeBaseUrl(baseUrl);
  const response = await fetchConnection(`${url}/models`, {
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
    const response = await fetchConnection(`${url}/embeddings`, {
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
  const response = await fetchConnection(`${url}/v1beta/models`, {
    method: "GET",
    headers: { "x-goog-api-key": apiKey },
  });
  if (response.ok) return { success: true, message: "连接成功" };
  if (response.status === 400 || response.status === 403) return { success: false, message: "API Key 无效" };
  return { success: false, message: `请求失败 (${response.status})` };
}

export async function testChannel(channelId: string): Promise<ChannelTestResult> {
  const channel = getChannelById(channelId);
  if (!channel) return { success: false, message: "渠道不存在" };
  const testedAt = Date.now();
  let result: ChannelTestResult;
  try {
    if (channel.authType === "oauth") {
      const { resolveConnectionOAuthAuth, getConnectionOAuthModels } = await import("./connection-oauth-service");
      const auth = await resolveConnectionOAuthAuth(channel.id);
      const models = await getConnectionOAuthModels(channel.id);
      result = auth && models.length > 0
        ? { success: true, message: `账号连接成功，可用模型 ${models.length} 个` }
        : { success: false, message: "订阅账号凭据不可用，请重新登录" };
    } else {
    const apiKey = decryptApiKey(channel.id);
    if (channel.provider === "jina") result = await testJina(channel.baseUrl, apiKey);
    else {
      const family = resolveProviderApiFamily(channel.provider, channel.baseUrl, channel.apiFamily);
      if (family === "anthropic") result = await testAnthropic(channel.baseUrl, apiKey);
      else if (family === "google") result = await testGoogle(channel.baseUrl, apiKey);
      else result = await testOpenAICompatible(channel.baseUrl, apiKey);
    }
    }
  } catch (error) {
    result = {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  updateChannel(channel.id, {
    healthStatus: result.success ? "available" : "unavailable",
    healthMessage: result.message,
    lastTestedAt: testedAt,
  });
  return { ...result, testedAt };
}

export async function testChannelDirect(input: FetchModelsInput): Promise<ChannelTestResult> {
  const testedAt = Date.now();
  let result: ChannelTestResult;
  if (input.provider === "jina") result = await testJina(input.baseUrl, input.apiKey);
  else {
  const family = resolveProviderApiFamily(input.provider, input.baseUrl, input.apiFamily);
    if (family === "anthropic") result = await testAnthropic(input.baseUrl, input.apiKey);
    else if (family === "google") result = await testGoogle(input.baseUrl, input.apiKey);
    else result = await testOpenAICompatible(input.baseUrl, input.apiKey);
  }
  return { ...result, testedAt };
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
  const response = await fetchConnection(`${url}/models`, { headers: authorizationHeaders(apiKey) });
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
  const response = await fetchConnection(`${url}/models`, {
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
  const response = await fetchConnection(`${url}/v1beta/models`, {
    headers: { "x-goog-api-key": apiKey },
  });
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
  const family = resolveProviderApiFamily(input.provider, input.baseUrl, input.apiFamily);
  if (family === "anthropic") return fetchAnthropicModels(input.baseUrl, input.apiKey);
  if (family === "google") return fetchGoogleModels(input.baseUrl, input.apiKey);
  return fetchOpenAICompatibleModels(input.provider, input.baseUrl, input.apiKey);
}

export function mergeSyncedModels(
  existing: ChannelModel[],
  discovered: ChannelModel[],
  provider: Channel["provider"]
): { models: ChannelModel[]; added: number; removed: number; preservedManual: number } {
  const discoveredById = new Map(discovered.map((model) => [model.id, model]));
  const previousDiscovered = existing.filter((model) => model.source === "discovered");
  const manual = existing.filter((model) => model.source !== "discovered");
  const manualIds = new Set(manual.map((model) => model.id));
  const previousById = new Map(previousDiscovered.map((model) => [model.id, model]));
  const synced = discovered
    .filter((model) => !manualIds.has(model.id))
    .map((model) => {
      const previous = previousById.get(model.id);
      return normalizeChannelModel({
        ...model,
        source: "discovered",
        enabled: previous?.enabled ?? true,
        provider,
      });
    });

  return {
    models: [...manual, ...synced],
    added: synced.filter((model) => !previousById.has(model.id)).length,
    removed: previousDiscovered.filter((model) => !discoveredById.has(model.id)).length,
    preservedManual: manual.length,
  };
}

export async function syncChannelModels(channelId: string): Promise<SyncChannelModelsResult> {
  const channel = getChannelById(channelId);
  if (!channel) throw new Error(`渠道不存在: ${channelId}`);
  let result: FetchModelsResult;
  try {
    result = channel.authType === "oauth"
      ? await fetchOAuthModels(channel)
      : await fetchModels({
        provider: channel.provider,
        baseUrl: channel.baseUrl,
        apiKey: decryptApiKey(channel.id),
        apiFamily: channel.apiFamily,
        openaiApiMode: channel.openaiApiMode,
      });
  } catch (error) {
    result = { success: false, message: error instanceof Error ? error.message : String(error), models: [] };
  }
  const now = Date.now();
  if (!result.success) {
    const updated = updateChannel(channel.id, {
      syncStatus: "error",
      syncMessage: result.message,
    });
    return {
      ...result,
      channel: updated,
      added: 0,
      removed: 0,
      preservedManual: channel.models.filter((model) => model.source !== "discovered").length,
    };
  }

  const merged = mergeSyncedModels(channel.models, result.models, channel.provider);
  const updated = updateChannel(channel.id, {
    models: merged.models,
    syncStatus: "success",
    syncMessage: result.message,
    lastSyncedAt: now,
    healthStatus: "available",
    healthMessage: result.message,
  });
  return { ...result, ...merged, channel: updated };
}

async function fetchOAuthModels(channel: Channel): Promise<FetchModelsResult> {
  const { getConnectionOAuthModels } = await import("./connection-oauth-service");
  const catalog = await getConnectionOAuthModels(channel.id);
  const models = catalog.map((model) => normalizeChannelModel({
    id: model.id,
    name: model.name || model.id,
    enabled: true,
    source: "discovered",
    provider: channel.provider,
    protocol: toConnectionProtocol(model.api),
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    capabilities: {
      chat: true,
      vision: model.input.includes("image"),
      reasoning: Boolean(model.reasoning),
      tool: true,
    },
  }));
  return { success: true, message: `成功获取 ${models.length} 个模型`, models };
}

function toConnectionProtocol(api: string): ConnectionProtocol {
  if (api === "anthropic-messages"
    || api === "openai-responses"
    || api === "openai-codex-responses"
    || api === "google-generative-ai") return api;
  return "openai-completions";
}
