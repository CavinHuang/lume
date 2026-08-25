import { type ApiType, type LLMProvider } from "@lume/agent-sdk";
import { stripAfterglowLines } from "@lume/shared";
import { decryptApiKey, resolveChannelModelBinding } from "../channel/channel-manager";
import type { LumeRunItem } from "../agent-runtime/runtime-core/run-items";
import type { LumeRunState } from "../agent-runtime/runtime-core/run-state";
import { getEffectiveLumeConfig } from "../system/lume-config-service";
import { resolveMemoryExtractionModelRefs } from "./extraction";
import { resolveChatProvider } from "./chat-provider";

export interface MemoryConversationSummaryInput {
  workspaceSlug?: string;
  runId: string;
  threadId: string;
  userMessage: string;
  runState?: Pick<LumeRunState, "generatedItems"> | null;
  fallbackSummary: string;
}

export type MemoryConversationSummarizer = (
  input: MemoryConversationSummaryInput
) => Promise<string | undefined>;

type ConversationSummaryProviderFactory = (input: {
  apiType: ApiType;
  apiKey: string;
  baseURL?: string;
}) => LLMProvider;

export function summarizeMemoryConversationFallback(input: {
  userMessage: string;
  runState?: Pick<LumeRunState, "generatedItems"> | null;
}): string {
  const lines = [`User asked: ${compactMemorySummaryText(input.userMessage)}`];
  const assistant = latestAssistantOutcome(input.runState?.generatedItems ?? []);
  if (assistant) {
    lines.push(`Assistant outcome: ${compactMemorySummaryText(assistant)}`);
  }
  const tools = uniqueToolNames(input.runState?.generatedItems ?? []);
  if (tools.length > 0) {
    lines.push(`Tools used: ${tools.slice(0, 8).join(", ")}`);
  }
  return lines.join("\n");
}

export function createMemoryConversationSummarizer(input: {
  workspaceSlug?: string;
  modelRef?: string;
  fallbackModelRefs?: string[];
  createProvider?: ConversationSummaryProviderFactory;
}): MemoryConversationSummarizer | undefined {
  const modelRefs = resolveMemoryExtractionModelRefs(getEffectiveLumeConfig(input.workspaceSlug), {
    modelRef: input.modelRef,
    fallbackModelRefs: input.fallbackModelRefs
  });
  if (modelRefs.length === 0) return undefined;
  return async (summaryInput) => {
    for (const modelRef of modelRefs) {
      try {
        const attempt = createConversationSummaryAttempt(modelRef, input.createProvider);
        if (!attempt) continue;
        const summary = await summarizeConversationWithLlm({ ...attempt, input: summaryInput });
        if (summary) return summary;
      } catch {
        continue;
      }
    }
    return undefined;
  };
}

function createConversationSummaryAttempt(
  modelRef: string,
  createProviderInput?: ConversationSummaryProviderFactory
): { provider: LLMProvider; model: string } | undefined {
  const binding = resolveChannelModelBinding(modelRef, "chat");
  if (!binding && !createProviderInput) return undefined;
  return {
    provider: createProviderInput
      ? createProviderInput({
        apiType: binding ? resolveConversationSummaryApiType(binding.channel.provider) : "openai-completions",
        apiKey: binding ? decryptApiKey(binding.channel.id) : "",
        baseURL: binding?.channel.baseUrl
      })
      : resolveChatProvider(modelRef),
    model: binding?.modelId ?? modelRef.split("/").at(-1) ?? modelRef
  };
}

async function summarizeConversationWithLlm(input: {
  provider: LLMProvider;
  model: string;
  input: MemoryConversationSummaryInput;
}): Promise<string | undefined> {
  const response = await input.provider.createMessage({
    model: input.model,
    maxTokens: 420,
    system: [
      "Summarize one completed Lume conversation turn for future memory recall.",
      "Use concise Chinese unless the source is clearly English.",
      "Capture what the user wanted, what the assistant actually did or decided, and a likely next step when obvious.",
      "Do not expose raw thread ids, model ids, JSON, or implementation metadata.",
      "Return plain text only, 1-3 short lines."
    ].join("\n"),
    messages: [{
      role: "user",
      content: JSON.stringify({
        userMessage: compactMemorySummaryText(input.input.userMessage, 700),
        fallbackSummary: input.input.fallbackSummary,
        assistantOutcome: latestAssistantOutcome(input.input.runState?.generatedItems ?? []),
        toolsUsed: uniqueToolNames(input.input.runState?.generatedItems ?? [])
      })
    }]
  });
  return normalizeGeneratedSummary(response.content
    .map((block) => block.type === "text" ? block.text : "")
    .filter(Boolean)
    .join("\n"));
}

function latestAssistantOutcome(items: LumeRunItem[]): string | undefined {
  for (const item of [...items].reverse()) {
    if (item.type !== "assistant_message") continue;
    const text = textFromContent(item.content);
    if (text) return text;
  }
  return undefined;
}

function uniqueToolNames(items: LumeRunItem[]): string[] {
  const names: string[] = [];
  for (const item of items) {
    if (item.type !== "tool_call") continue;
    if (!names.includes(item.toolName)) names.push(item.toolName);
  }
  return names;
}

function textFromContent(value: unknown): string | undefined {
  if (typeof value === "string") return stripAfterglowLines(value).trim() || undefined;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const record = block as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  const stripped = stripAfterglowLines(text).trim();
  return stripped || undefined;
}

function normalizeGeneratedSummary(value: string): string | undefined {
  const compact = value
    .replace(/^```(?:\w+)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return undefined;
  return compactMemorySummaryText(compact, 700);
}

export function compactMemorySummaryText(value: string, maxLength = 260): string {
  const compact = stripAfterglowLines(value).replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 3)}...`;
}

function resolveConversationSummaryApiType(provider: string): ApiType {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "anthropic-compatible") return "anthropic-messages";
  if (normalized === "deepseek") return "deepseek-chat-completions";
  return "openai-completions";
}
