import type {
  ApiType,
  CreateMessageParams,
  CreateMessageResponse,
  CreateMessageStreamEvent,
  LLMProvider,
} from "@lume/agent-sdk";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { PROVIDER_DEFAULT_URLS, type Channel } from "@lume/shared";
import { decryptApiKey, getChannelById, updateChannel } from "../channel/channel-manager";
import { getConnectionOAuthProviderId, resolveConnectionOAuthAuth } from "../channel/connection-oauth-service";
import { createRoutingPiAiProvider, type PiAiProviderRoute } from "./pi-ai-provider";

const BUILTIN_PROVIDERS = builtinProviders();

/**
 * 运行期渠道不可用时同步降级健康徽章（#595）：否则 healthStatus 停留在上次
 * 显式测试的结果上，绿点成了遗像，用户无法把「run 老是失败」和渠道故障关联。
 */
function throwWithHealthDegradation(channel: Channel, message: string): never {
  try {
    updateChannel(channel.id, {
      healthStatus: "unavailable",
      healthMessage: message,
    });
  } catch {
    // 降级失败不影响原错误上抛
  }
  throw new Error(message);
}

export async function createConnectionLlmProvider(input: {
  channel: Channel;
  modelId: string;
  sessionId?: string;
  signal?: AbortSignal;
}): Promise<LLMProvider> {
  return createRoutingPiAiProvider([await createConnectionPiAiRoute(input)]);
}

/** Keeps synchronous call sites while deferring OAuth refresh and provider loading until first use. */
export function createLazyConnectionLlmProvider(input: {
  connectionId: string;
  modelId: string;
  sessionId?: string;
}): LLMProvider {
  const configuredChannel = getChannelById(input.connectionId);
  const configuredModel = configuredChannel?.models.find((model) => model.id === input.modelId);
  let resolved: Promise<LLMProvider> | undefined;
  const getProvider = () => {
    resolved ??= (async () => {
      const channel = getChannelById(input.connectionId);
      if (!channel) throw new Error(`渠道不存在: ${input.connectionId}`);
      return createConnectionLlmProvider({ channel, modelId: input.modelId, sessionId: input.sessionId });
    })();
    return resolved;
  };
  return {
    apiType: configuredChannel
      ? resolveConfiguredConnectionApiType(configuredChannel, input.modelId)
      : "openai-completions",
    async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
      return (await getProvider()).createMessage(params);
    },
    async *createMessageStream(
      params: CreateMessageParams,
    ): AsyncGenerator<CreateMessageStreamEvent, CreateMessageResponse> {
      const stream = (await getProvider()).createMessageStream!(params);
      while (true) {
        const next = await stream.next();
        if (next.done) return next.value;
        yield next.value;
      }
    },
  };
}

export async function createConnectionPiAiRoute(input: {
  channel: Channel;
  modelId: string;
  sessionId?: string;
  signal?: AbortSignal;
}): Promise<PiAiProviderRoute> {
  if (!input.channel.enabled) throwWithHealthDegradation(input.channel, "connection_disabled");
  const configuredModel = input.channel.models.find((item) => item.id === input.modelId);
  if (configuredModel && !configuredModel.enabled) throwWithHealthDegradation(input.channel, "connection_model_disabled");
  const routeModelId = stripMatchingConnectionProviderPrefix(input.channel, input.modelId);
  const oauth = await resolveConnectionOAuthAuth(input.channel.id, input.signal).catch((error: unknown) => {
    // OAuth refresh 运行期失败同样降级徽章（#595）：凭据吊销/过期不该只进 run 错误
    throwWithHealthDegradation(
      input.channel,
      `connection_oauth_credential_unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
  });
  if (input.channel.authType === "oauth" && !oauth) {
    throwWithHealthDegradation(input.channel, "connection_oauth_credential_unavailable");
  }
  const apiKey = oauth?.auth.apiKey ?? decryptApiKey(input.channel.id);
  if (input.channel.authType === "api-key" && !apiKey) {
    throwWithHealthDegradation(input.channel, "connection_api_key_unavailable");
  }
  const catalogModel = findConnectionCatalogModel(input.channel, routeModelId, oauth?.providerId);
  const apiType = resolveConnectionApiType(input.channel, configuredModel?.protocol, catalogModel?.api);
  const catalogBaseUrl = shouldUseCatalogBaseUrl(input.channel) ? catalogModel?.baseUrl : undefined;
  return {
    modelId: routeModelId,
    apiType,
    providerId: oauth?.providerId ?? input.channel.providerId ?? input.channel.provider,
    baseUrl: oauth?.auth.baseUrl ?? catalogBaseUrl ?? (input.channel.baseUrl || catalogModel?.baseUrl || ""),
    apiKey,
    headers: normalizeHeaders({ ...(catalogModel?.headers ?? {}), ...(oauth?.auth.headers ?? {}) }),
    contextWindow: configuredModel?.contextWindow ?? catalogModel?.contextWindow,
    maxTokens: configuredModel?.maxOutputTokens ?? catalogModel?.maxTokens,
    supportsReasoning: configuredModel?.capabilities?.reasoning ?? catalogModel?.reasoning,
    thinkingLevelMap: catalogModel?.thinkingLevelMap,
    compat: catalogModel?.compat,
    sessionId: input.sessionId,
  };
}

export function resolveConfiguredConnectionApiType(channel: Channel, modelId: string): ApiType {
  return resolveConnectionApiType(
    channel,
    channel.models.find((model) => model.id === modelId)?.protocol,
    findConnectionCatalogModel(channel, modelId)?.api,
  );
}

/**
 * 渠道配置或内置目录真实提供的输出上限(#561);两者皆缺时返回 undefined——
 * 调用方不得以兜底猜测抬高请求(自建网关 max_tokens 翻倍会触发上游 400 且不切 fallback,#631 review)。
 */
export function resolveConnectionModelMaxTokens(channel: Channel, modelId: string): number | undefined {
  const configuredModel = channel.models.find((item) => item.id === modelId);
  if (configuredModel?.maxOutputTokens !== undefined) return configuredModel.maxOutputTokens;
  return findConnectionCatalogModel(channel, stripMatchingConnectionProviderPrefix(channel, modelId))?.maxTokens;
}

function findConnectionCatalogModel(channel: Channel, modelId: string, oauthProviderId?: string) {
  const providerId = oauthProviderId
    ?? getConnectionOAuthProviderId(channel)
    ?? channel.providerId
    ?? channel.provider;
  const catalogModelId = stripMatchingConnectionProviderPrefix(channel, modelId);
  return BUILTIN_PROVIDERS
    .find((provider) => provider.id === providerId)
    ?.getModels()
    .find((model) => model.id === catalogModelId);
}

function stripMatchingConnectionProviderPrefix(channel: Channel, modelId: string): string {
  const providerId = (channel.providerId ?? channel.provider).trim().toLowerCase();
  const separator = modelId.indexOf("/");
  if (separator <= 0 || modelId.slice(0, separator).trim().toLowerCase() !== providerId) return modelId;
  return modelId.slice(separator + 1).trim() || modelId;
}

function shouldUseCatalogBaseUrl(channel: Channel): boolean {
  const configuredDefault = PROVIDER_DEFAULT_URLS[channel.provider];
  return Boolean(configuredDefault)
    && normalizeBaseUrl(channel.baseUrl) === normalizeBaseUrl(configuredDefault);
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

function resolveConnectionApiType(
  channel: Channel,
  modelProtocol?: Channel["protocol"],
  catalogApi?: string,
): ApiType {
  const connectionOverride = channel.provider === "custom"
    || channel.protocol !== defaultConnectionProtocol(channel);
  const explicit = modelProtocol
    ?? (connectionOverride ? channel.protocol : undefined)
    ?? catalogApi
    ?? channel.protocol;
  if (explicit === "anthropic-messages"
    || explicit === "openai-completions"
    || explicit === "openai-responses"
    || explicit === "openai-codex-responses"
    || explicit === "google-generative-ai") return explicit;
  if (channel.provider === "google") return "google-generative-ai";
  if (channel.provider === "anthropic" || channel.provider === "anthropic-compatible") {
    return "anthropic-messages";
  }
  if (channel.provider === "openai-codex") return "openai-codex-responses";
  if (channel.openaiApiMode === "responses") return "openai-responses";
  return channel.provider === "deepseek" ? "deepseek-chat-completions" : "openai-completions";
}

function defaultConnectionProtocol(channel: Channel): Channel["protocol"] {
  if (channel.provider === "anthropic" || channel.provider === "anthropic-compatible") {
    return "anthropic-messages";
  }
  if (channel.provider === "google") return "google-generative-ai";
  if (channel.provider === "openai-codex") return "openai-codex-responses";
  if (channel.provider === "openai" && channel.openaiApiMode === "responses") return "openai-responses";
  return "openai-completions";
}

function normalizeHeaders(headers: Record<string, string | null | undefined> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const entries = Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length ? Object.fromEntries(entries) : undefined;
}
