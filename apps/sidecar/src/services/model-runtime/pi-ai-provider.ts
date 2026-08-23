import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Message,
  Model,
  ProviderStreams,
  StopReason,
  Tool,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type {
  ApiType,
  CreateMessageParams,
  CreateMessageResponse,
  CreateMessageStreamEvent,
  LLMProvider,
  NormalizedContentBlock,
  NormalizedMessageParam,
  NormalizedResponseBlock,
} from "@lume/agent-sdk";
import { MAX_RETRY_AFTER_DELAY_MS, parseRetryAfterHeader } from "@lume/agent-sdk";

type PiTextApi = "openai-completions" | "openai-responses" | "openai-codex-responses" | "anthropic-messages" | "google-generative-ai";

const DEFAULT_MAX_RETRIES = 5;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

export interface PiAiProviderOptions {
  apiType: ApiType;
  providerId: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  contextWindow?: number;
  maxTokens?: number;
  supportsReasoning?: boolean;
  sessionId?: string;
}

export interface PiAiProviderRoute extends PiAiProviderOptions {
  modelId: string;
}

export class PiAiProviderError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, options: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "PiAiProviderError";
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function isRetryablePiAiError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return false;
  const status = typeof (error as { status?: unknown } | null)?.status === "number"
    ? (error as { status: number }).status
    : undefined;
  if (status === undefined) {
    if (!(error instanceof PiAiProviderError)) return true;
    return /network|fetch|socket|timeout|timed out|connection|econn|enotfound|eai_again/i.test(error.message);
  }
  return status === 408
    || status === 409
    || status === 425
    || status === 429
    || status === 500
    || status === 502
    || status === 503
    || status === 504
    || status === 529;
}

export function resolvePiAiRetryDelayMs(error: unknown, retryIndex: number, random = Math.random): number {
  const base = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)] ?? RETRY_DELAYS_MS.at(-1)!;
  const jittered = Math.round(base * (0.8 + random() * 0.4));
  const retryAfter = typeof (error as { retryAfterMs?: unknown } | null)?.retryAfterMs === "number"
    ? Math.min(MAX_RETRY_AFTER_DELAY_MS, Math.max(0, (error as { retryAfterMs: number }).retryAfterMs))
    : 0;
  return Math.max(jittered, retryAfter);
}

export function shouldTryNextPiAiRoute(error: unknown, hasFallback: boolean, aborted = false): boolean {
  if (aborted || !hasFallback) return false;
  const status = typeof (error as { status?: unknown } | null)?.status === "number"
    ? (error as { status: number }).status
    : undefined;
  return status !== 400 && status !== 422;
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

function toPiApi(apiType: ApiType): PiTextApi {
  return apiType === "deepseek-chat-completions" ? "openai-completions" : apiType;
}

export function resolvePiModelInput(messages: NormalizedMessageParam[]): Array<"text" | "image"> {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "image") return ["text", "image"];
      if (
        block.type === "tool_result"
        && Array.isArray(block.content)
        && block.content.some((item) => item.type === "image")
      ) {
        return ["text", "image"];
      }
    }
  }
  return ["text"];
}

async function loadStreams(api: PiTextApi): Promise<ProviderStreams> {
  switch (api) {
    case "openai-completions":
      return import("@earendil-works/pi-ai/api/openai-completions");
    case "openai-responses":
      return import("@earendil-works/pi-ai/api/openai-responses");
    case "openai-codex-responses":
      return import("@earendil-works/pi-ai/api/openai-codex-responses");
    case "anthropic-messages":
      return import("@earendil-works/pi-ai/api/anthropic-messages");
    case "google-generative-ai":
      return import("@earendil-works/pi-ai/api/google-generative-ai");
  }
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function imageFromSource(source: unknown): ImageContent | undefined {
  if (!source || typeof source !== "object") return undefined;
  const value = source as Record<string, unknown>;
  const data = typeof value.data === "string" ? value.data : undefined;
  const mimeType = typeof value.mimeType === "string"
    ? value.mimeType
    : typeof value.media_type === "string"
      ? value.media_type
      : undefined;
  return data && mimeType ? { type: "image", data, mimeType } : undefined;
}

function toolResultContent(content: Extract<NormalizedContentBlock, { type: "tool_result" }>["content"]): ToolResultMessage["content"] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  const result: ToolResultMessage["content"] = [];
  for (const block of content) {
    if (block.type === "text") {
      result.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "image") {
      const image = imageFromSource(block.source ?? block);
      if (image) result.push(image);
      continue;
    }
    result.push({ type: "text", text: "[Document result omitted from model transport]" });
  }
  return result.length > 0 ? result : [{ type: "text", text: "" }];
}

function userContent(blocks: NormalizedContentBlock[]): Array<{ type: "text"; text: string } | ImageContent> {
  const result: Array<{ type: "text"; text: string } | ImageContent> = [];
  for (const block of blocks) {
    if (block.type === "text") result.push({ type: "text", text: block.text });
    if (block.type === "image") {
      const image = imageFromSource(block.source);
      if (image) result.push(image);
    }
  }
  return result;
}

function toPiMessages(
  messages: NormalizedMessageParam[],
  model: Model<PiTextApi>,
): Message[] {
  const result: Message[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      result.push({
        role: "user",
        content: message.content,
        timestamp: Date.now(),
      });
      continue;
    }

    if (message.role === "assistant") {
      const content: AssistantMessage["content"] = [];
      for (const block of message.content) {
        if (block.type === "text") content.push({ type: "text", text: block.text });
        if (block.type === "thinking") content.push({ type: "thinking", thinking: block.thinking });
        if (block.type === "tool_use") {
          content.push({ type: "toolCall", id: block.id, name: block.name, arguments: block.input ?? {} });
        }
      }
      result.push({
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage(),
        stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
        timestamp: Date.now(),
      });
      continue;
    }

    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      result.push({
        role: "toolResult",
        toolCallId: block.tool_use_id,
        toolName: typeof block._meta?.toolName === "string" ? block._meta.toolName : "tool",
        content: toolResultContent(block.content),
        isError: block.is_error === true,
        timestamp: Date.now(),
      });
    }
    const content = userContent(message.content);
    if (content.length > 0) {
      result.push({
        role: "user",
        content: content.length === 1 && content[0]?.type === "text" ? content[0].text : content,
        timestamp: Date.now(),
      });
    }
  }
  return result;
}

function toPiTools(tools: CreateMessageParams["tools"]): Tool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema as Tool["parameters"],
  }));
}

function toResponseBlock(block: AssistantMessage["content"][number]): NormalizedResponseBlock {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "thinking") return { type: "thinking", thinking: block.thinking };
  return { type: "tool_use", id: block.id, name: block.name, input: block.arguments };
}

function toStopReason(reason: StopReason): CreateMessageResponse["stopReason"] {
  if (reason === "toolUse") return "tool_use";
  if (reason === "length") return "max_tokens";
  return reason === "stop" ? "end_turn" : reason;
}

function toResponse(message: AssistantMessage): CreateMessageResponse {
  return {
    content: message.content.map(toResponseBlock),
    stopReason: toStopReason(message.stopReason),
    usage: {
      input_tokens: message.usage.input,
      output_tokens: message.usage.output,
      cache_creation_input_tokens: message.usage.cacheWrite,
      cache_read_input_tokens: message.usage.cacheRead,
    },
  };
}

function retryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  return parseRetryAfterHeader(headers?.["retry-after"] ?? headers?.["Retry-After"]);
}

function structuredOutputTransform(api: PiTextApi, schema: Record<string, unknown> | undefined) {
  if (!schema) return undefined;
  return (payload: unknown): unknown => {
    if (!payload || typeof payload !== "object") return payload;
    const value = payload as Record<string, unknown>;
    if (api === "openai-completions") {
      return { ...value, response_format: { type: "json_schema", json_schema: { name: "response", strict: true, schema } } };
    }
    if (api === "openai-responses" || api === "openai-codex-responses") {
      const text = value.text && typeof value.text === "object" ? value.text as Record<string, unknown> : {};
      return { ...value, text: { ...text, format: { type: "json_schema", name: "response", strict: true, schema } } };
    }
    if (api === "anthropic-messages") {
      const outputConfig = value.output_config && typeof value.output_config === "object"
        ? value.output_config as Record<string, unknown>
        : {};
      return { ...value, output_config: { ...outputConfig, format: { type: "json_schema", schema } } };
    }
    const generationConfig = value.generationConfig && typeof value.generationConfig === "object"
      ? value.generationConfig as Record<string, unknown>
      : {};
    return {
      ...value,
      generationConfig: {
        ...generationConfig,
        responseMimeType: "application/json",
        responseJsonSchema: schema,
      },
    };
  };
}

export class PiAiProvider implements LLMProvider {
  readonly apiType: ApiType;

  constructor(private readonly options: PiAiProviderOptions) {
    this.apiType = options.apiType;
  }

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    const stream = this.createMessageStream(params);
    while (true) {
      const next = await stream.next();
      if (next.done) return next.value;
    }
  }

  async *createMessageStream(
    params: CreateMessageParams,
  ): AsyncGenerator<CreateMessageStreamEvent, CreateMessageResponse> {
    const api = toPiApi(this.options.apiType);
    const model: Model<PiTextApi> = {
      id: params.model,
      name: params.model,
      api,
      provider: this.options.providerId,
      baseUrl: this.options.baseUrl,
      reasoning: this.options.supportsReasoning ?? params.thinking?.type !== "disabled",
      input: resolvePiModelInput(params.messages),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: this.options.contextWindow ?? 128_000,
      maxTokens: this.options.maxTokens ?? params.maxTokens,
    };
    const context: Context = {
      systemPrompt: params.system,
      messages: toPiMessages(params.messages, model),
      tools: toPiTools(params.tools),
    };
    const streams = await loadStreams(api);
    let retryActive = false;

    for (let retryIndex = 0; ; retryIndex += 1) {
      let responseStatus: number | undefined;
      let responseHeaders: Record<string, string> | undefined;
      try {
        const output: AssistantMessageEventStream = streams.streamSimple(model as Model<Api>, context, {
          apiKey: this.options.apiKey,
          headers: this.options.headers,
          signal: params.abortSignal,
          maxTokens: params.maxTokens,
          maxRetries: 0,
          maxRetryDelayMs: MAX_RETRY_AFTER_DELAY_MS,
          sessionId: this.options.sessionId ?? params.promptCache?.routingKey,
          cacheRetention: params.promptCache?.ttl === "5m" ? "short" : "none",
          ...(params.thinking?.type === "disabled" ? {} : { reasoning: params.effort ?? "medium" }),
          onPayload: structuredOutputTransform(api, params.outputFormat?.schema ?? params.jsonSchema),
          onResponse(response) {
            responseStatus = response.status;
            responseHeaders = response.headers;
          },
        });

        for await (const event of output) {
          if (event.type === "text_delta" || event.type === "thinking_delta") {
            if (retryActive) {
              retryActive = false;
              yield {
                type: "retry_state",
                phase: "cleared",
                attempt: retryIndex,
                maxRetries: DEFAULT_MAX_RETRIES,
                retryDelayMs: 0,
                errorStatus: null,
              };
            }
            if (event.type === "text_delta") yield { type: "text_delta", text: event.delta };
            else yield { type: "thinking_delta", thinking: event.delta };
            continue;
          }
          if (event.type === "done") {
            if (retryActive) {
              yield {
                type: "retry_state",
                phase: "cleared",
                attempt: retryIndex,
                maxRetries: DEFAULT_MAX_RETRIES,
                retryDelayMs: 0,
                errorStatus: null,
              };
            }
            return toResponse(event.message);
          }
          if (event.type === "error") {
            throw new PiAiProviderError(event.error.errorMessage ?? "pi-ai provider request failed", {
              status: responseStatus,
              retryAfterMs: retryAfterMs(responseHeaders),
            });
          }
        }
        throw new PiAiProviderError("pi-ai provider stream ended without a terminal event", {
          status: responseStatus,
          retryAfterMs: retryAfterMs(responseHeaders),
        });
      } catch (cause) {
        if (params.abortSignal?.aborted || retryIndex >= DEFAULT_MAX_RETRIES || !isRetryablePiAiError(cause)) {
          throw cause;
        }
        const delayMs = resolvePiAiRetryDelayMs(cause, retryIndex);
        const attempt = retryIndex + 1;
        const status = typeof (cause as { status?: unknown } | null)?.status === "number"
          ? (cause as { status: number }).status
          : null;
        retryActive = true;
        yield {
          type: "retry_state",
          phase: "waiting",
          attempt,
          maxRetries: DEFAULT_MAX_RETRIES,
          retryDelayMs: delayMs,
          errorStatus: status,
        };
        await waitForRetry(delayMs, params.abortSignal);
        yield {
          type: "retry_state",
          phase: "retrying",
          attempt,
          maxRetries: DEFAULT_MAX_RETRIES,
          retryDelayMs: 0,
          errorStatus: status,
        };
      }
    }
  }
}

export function createPiAiProvider(options: PiAiProviderOptions): LLMProvider {
  return new PiAiProvider(options);
}

class RoutingPiAiProvider implements LLMProvider {
  readonly apiType: ApiType;

  constructor(private readonly routes: PiAiProviderRoute[]) {
    if (routes.length === 0) throw new Error("pi-ai routing requires at least one model route");
    this.apiType = routes[0]!.apiType;
  }

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    const stream = this.createMessageStream(params);
    while (true) {
      const next = await stream.next();
      if (next.done) return next.value;
    }
  }

  async *createMessageStream(
    params: CreateMessageParams,
  ): AsyncGenerator<CreateMessageStreamEvent, CreateMessageResponse> {
    let switchingRoute = false;
    for (let index = 0; index < this.routes.length; index += 1) {
      const route = this.routes[index]!;
      const provider = new PiAiProvider(route);
      try {
        const stream = provider.createMessageStream({ ...params, model: route.modelId });
        while (true) {
          const next = await stream.next();
          if (next.done) {
            if (switchingRoute) {
              yield {
                type: "retry_state",
                phase: "cleared",
                attempt: DEFAULT_MAX_RETRIES,
                maxRetries: DEFAULT_MAX_RETRIES,
                retryDelayMs: 0,
                errorStatus: null,
              };
            }
            return next.value;
          }
          if (switchingRoute && (next.value.type === "text_delta" || next.value.type === "thinking_delta")) {
            switchingRoute = false;
            yield {
              type: "retry_state",
              phase: "cleared",
              attempt: DEFAULT_MAX_RETRIES,
              maxRetries: DEFAULT_MAX_RETRIES,
              retryDelayMs: 0,
              errorStatus: null,
            };
          }
          yield next.value;
        }
      } catch (cause) {
        const status = typeof (cause as { status?: unknown } | null)?.status === "number"
          ? (cause as { status: number }).status
          : null;
        const hasFallback = index + 1 < this.routes.length;
        if (!shouldTryNextPiAiRoute(cause, hasFallback, params.abortSignal?.aborted === true)) throw cause;
        switchingRoute = true;
        yield {
          type: "retry_state",
          phase: "waiting",
          attempt: DEFAULT_MAX_RETRIES,
          maxRetries: DEFAULT_MAX_RETRIES,
          retryDelayMs: 0,
          errorStatus: status,
        };
        yield {
          type: "retry_state",
          phase: "retrying",
          attempt: DEFAULT_MAX_RETRIES,
          maxRetries: DEFAULT_MAX_RETRIES,
          retryDelayMs: 0,
          errorStatus: status,
        };
      }
    }
    throw new Error("pi-ai routing exhausted without a response");
  }
}

export function createRoutingPiAiProvider(routes: PiAiProviderRoute[]): LLMProvider {
  return routes.length === 1 ? new PiAiProvider(routes[0]!) : new RoutingPiAiProvider(routes);
}
