import {
  type ApiType,
  type LLMProvider,
  type NormalizedContentBlock,
  type NormalizedMessageParam,
  type NormalizedTool
} from "@lume/agent-sdk";
import type { ReadingModelUsage, ReadingNoteDepth, ReadingSettings } from "@lume/shared";
import { decryptApiKey, resolveChannelModelBinding } from "../channel/channel-manager";
import { createLazyConnectionLlmProvider } from "../model-runtime/connection-provider";
import { getEffectiveLumeConfig } from "../system/lume-config-service";
import { getReadingSettings } from "./reading-store";
import type {
  ReadingNoteGeneratorLlm,
  ReadingNoteGeneratorMessage,
  ReadingNoteGeneratorStreamEvent,
  ReadingNoteGeneratorStreamRequest,
  ReadingNoteGeneratorToolDescriptor
} from "./reading-note-generator";

interface ReadingModelBinding {
  channel: {
    id: string;
    provider: string;
    baseUrl?: string;
  };
  modelId: string;
  family?: "anthropic" | "openai" | "google";
}

type ReadingProviderFactory = (input: {
  apiType: ApiType;
  apiKey: string;
  baseURL?: string;
}) => LLMProvider;

interface ReadingEffectiveConfigLike {
  models?: {
    chat?: {
      defaultModelRef?: string;
    };
    agent?: {
      defaultModelRef?: string;
    };
  };
}

export interface ReadingNoteGeneratorLlmAttempt {
  modelRef: string;
  llm: ReadingNoteGeneratorLlm;
}

export interface CreateReadingNoteGeneratorLlmInput {
  depth: ReadingNoteDepth;
  settings?: ReadingSettings;
  workspaceSlug?: string;
  resolveBinding?: (modelRef: string) => ReadingModelBinding | null;
  decryptApiKey?: (channelId: string) => string;
  createProvider?: ReadingProviderFactory;
  getEffectiveConfig?: (workspaceSlug?: string) => ReadingEffectiveConfigLike;
}

export function createReadingNoteGeneratorLlm(
  input: CreateReadingNoteGeneratorLlmInput
): ReadingNoteGeneratorLlmAttempt | undefined {
  const settings = input.settings ?? getReadingSettings();
  const modelRef = resolveReadingModelRef({
    depth: input.depth,
    settings,
    workspaceSlug: input.workspaceSlug,
    getEffectiveConfig: input.getEffectiveConfig
  });
  if (!modelRef) return undefined;

  const binding = (input.resolveBinding ?? defaultResolveBinding)(modelRef);
  if (!binding) return undefined;

  const provider = input.createProvider
    ? input.createProvider({
      apiType: resolveReadingApiType(binding),
      apiKey: (input.decryptApiKey ?? decryptApiKey)(binding.channel.id),
      baseURL: binding.channel.baseUrl
    })
    : createLazyConnectionLlmProvider({ connectionId: binding.channel.id, modelId: binding.modelId });

  return {
    modelRef,
    llm: new ProviderReadingNoteGeneratorLlm(provider, binding.modelId)
  };
}

function resolveReadingModelRef(input: {
  depth: ReadingNoteDepth;
  settings: ReadingSettings;
  workspaceSlug?: string;
  getEffectiveConfig?: (workspaceSlug?: string) => ReadingEffectiveConfigLike;
}): string | undefined {
  const depthModel = input.depth === "deep"
    ? input.settings.advanced.deepModelRef
    : input.settings.advanced.seedModelRef;
  if (isNonEmptyString(depthModel)) return depthModel.trim();
  if (input.settings.textModelMode === "explicit" && isNonEmptyString(input.settings.textModelRef)) {
    return input.settings.textModelRef.trim();
  }
  const effective = (input.getEffectiveConfig ?? getEffectiveLumeConfig)(input.workspaceSlug);
  const chatModel = effective.models?.chat?.defaultModelRef;
  if (isNonEmptyString(chatModel)) return chatModel.trim();
  const agentModel = effective.models?.agent?.defaultModelRef;
  return isNonEmptyString(agentModel) ? agentModel.trim() : undefined;
}

function defaultResolveBinding(modelRef: string): ReadingModelBinding | null {
  return resolveChannelModelBinding(modelRef, "chat");
}

class ProviderReadingNoteGeneratorLlm implements ReadingNoteGeneratorLlm {
  constructor(
    private readonly provider: LLMProvider,
    private readonly model: string
  ) {}

  async *stream(request: ReadingNoteGeneratorStreamRequest): AsyncIterable<ReadingNoteGeneratorStreamEvent> {
    const response = await this.provider.createMessage({
      model: this.model,
      maxTokens: request.caller === "reading-note-gen-converge" ? 900 : 1800,
      system: collectSystemPrompt(request.messages),
      messages: convertMessages(request.messages),
      tools: request.tools.length ? request.tools.map(convertTool) : undefined
    });

    for (const block of response.content) {
      if (block.type === "text" && block.text) {
        yield { type: "text", text: block.text };
      }
      if (block.type === "tool_use") {
        yield {
          type: "tool_call",
          id: block.id,
          name: block.name,
          arguments: block.input
        };
      }
    }

    const usage = normalizeUsage(request.modelRef, response.usage);
    if (usage.totalTokens || usage.promptTokens || usage.completionTokens) {
      yield { type: "usage", usage };
    }
  }
}

function collectSystemPrompt(messages: ReadingNoteGeneratorMessage[]): string {
  return messages
    .filter((message) => message.role === "system" && message.content.trim())
    .map((message) => message.content.trim())
    .join("\n\n");
}

function convertMessages(messages: ReadingNoteGeneratorMessage[]): NormalizedMessageParam[] {
  const converted: NormalizedMessageParam[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      converted.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: message.toolCallId ?? message.name ?? "tool-call",
          content: message.content
        }]
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      const content: NormalizedContentBlock[] = [];
      if (message.content.trim()) {
        content.push({ type: "text", text: message.content });
      }
      for (const toolCall of message.toolCalls) {
        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.name,
          input: parseToolInput(toolCall.arguments)
        });
      }
      converted.push({
        role: "assistant",
        content
      });
      continue;
    }
    converted.push({
      role: message.role,
      content: message.content
    });
  }
  return converted;
}

function convertTool(tool: ReadingNoteGeneratorToolDescriptor): NormalizedTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: normalizeToolSchema(tool.inputSchema)
  };
}

function normalizeToolSchema(schema: Record<string, unknown>): NormalizedTool["input_schema"] {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {})
  };
}

function parseToolInput(value: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) return {};
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeUsage(
  modelRef: string,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
  }
): ReadingModelUsage {
  const promptTokens = normalizePositiveInteger(usage.input_tokens);
  const completionTokens = normalizePositiveInteger(usage.output_tokens);
  const totalTokens = (promptTokens ?? 0) + (completionTokens ?? 0);
  return {
    modelRef,
    ...(promptTokens ? { promptTokens } : {}),
    ...(completionTokens ? { completionTokens } : {}),
    ...(totalTokens > 0 ? { totalTokens } : {})
  };
}

function resolveReadingApiType(binding: ReadingModelBinding): ApiType {
  if (binding.family === "anthropic") return "anthropic-messages";
  const normalized = binding.channel.provider.trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "anthropic-compatible") return "anthropic-messages";
  if (normalized === "deepseek") return "deepseek-chat-completions";
  return "openai-completions";
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
