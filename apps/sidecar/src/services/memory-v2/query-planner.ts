import { createProvider, type ApiType, type LLMProvider } from "@lume/agent-sdk";
import { decryptApiKey, resolveChannelModelBinding } from "../channel/channel-manager";
import {
  MEMORY_CLAIM_IDENTITY,
  MEMORY_CLAIM_PREFERENCE,
  MEMORY_CLAIM_PREFERRED_NAME,
  MEMORY_CLAIM_SOURCE_OF_TRUTH,
  MEMORY_CLAIM_SUBJECT_ASSISTANT,
  MEMORY_CLAIM_SUBJECT_USER,
  MEMORY_CLAIM_SUBJECT_WORKSPACE,
  type MemoryV2QueryPlan
} from "./claim";
import { resolveMemoryRerankModelRef } from "./rerank";

export type MemoryV2PlanQuery = (query: string) => Promise<MemoryV2QueryPlan | undefined>;

type QueryPlannerProviderFactory = (input: {
  apiType: ApiType;
  apiKey: string;
  baseURL?: string;
}) => LLMProvider;

export function createMemoryV2QueryPlanner(input: {
  workspaceSlug?: string;
  modelRef?: string;
  createProvider?: QueryPlannerProviderFactory;
}): MemoryV2PlanQuery | undefined {
  const resolved = resolveMemoryRerankModelRef({
    workspaceSlug: input.workspaceSlug,
    explicitModelRef: input.modelRef
  });
  if (!resolved.modelRef) return undefined;
  const binding = resolveChannelModelBinding(resolved.modelRef, "chat");
  if (!binding && !input.createProvider) return undefined;
  const providerFactory = input.createProvider ?? ((options) => createProvider(options.apiType, {
    apiKey: options.apiKey,
    baseURL: options.baseURL
  }));
  const provider = providerFactory({
    apiType: binding ? resolveQueryPlannerApiType(binding.channel.provider) : "openai-completions",
    apiKey: binding ? decryptApiKey(binding.channel.id) : "",
    baseURL: binding?.channel.baseUrl
  });
  const model = binding?.modelId ?? resolved.modelRef.split("/").at(-1) ?? resolved.modelRef;
  return (query) => planQueryWithLlm({ provider, model, query });
}

async function planQueryWithLlm(input: {
  provider: LLMProvider;
  model: string;
  query: string;
}): Promise<MemoryV2QueryPlan | undefined> {
  const response = await input.provider.createMessage({
    model: input.model,
    maxTokens: 220,
    system: buildQueryPlannerSystemPrompt(),
    messages: [{
      role: "user",
      content: JSON.stringify({
        query: input.query,
        output: {
          querySubject: [
            MEMORY_CLAIM_SUBJECT_USER,
            MEMORY_CLAIM_SUBJECT_ASSISTANT,
            MEMORY_CLAIM_SUBJECT_WORKSPACE,
            "open string or omit"
          ],
          desiredPredicates: [
            MEMORY_CLAIM_PREFERRED_NAME,
            MEMORY_CLAIM_IDENTITY,
            MEMORY_CLAIM_PREFERENCE,
            MEMORY_CLAIM_SOURCE_OF_TRUTH,
            "open string"
          ],
          includeConversationHistory: false
        }
      })
    }]
  });
  const text = response.content
    .map((block) => block.type === "text" ? block.text : "")
    .filter(Boolean)
    .join("\n");
  return parseQueryPlan(text);
}

function buildQueryPlannerSystemPrompt(): string {
  return [
    "Plan Lume memory recall for one user query.",
    "Return strict JSON only with shape {\"querySubject\":\"...\",\"desiredPredicates\":[\"...\"],\"includeConversationHistory\":false}.",
    "Do not answer the user. Do not create facts. Only classify what stable claims should be searched.",
    `Use ${MEMORY_CLAIM_SUBJECT_USER} for questions about the user's identity, name, preferences, habits, rules, or reporting style.`,
    `Use ${MEMORY_CLAIM_SUBJECT_ASSISTANT} for questions about the assistant's user-given name or identity preference.`,
    `Use ${MEMORY_CLAIM_SUBJECT_WORKSPACE} for workspace/project facts, decisions, source of truth, or current project state.`,
    `Prefer predicates ${MEMORY_CLAIM_PREFERRED_NAME}, ${MEMORY_CLAIM_IDENTITY}, ${MEMORY_CLAIM_PREFERENCE}, and ${MEMORY_CLAIM_SOURCE_OF_TRUTH}; use a short open predicate only when needed.`,
    "Set includeConversationHistory true only when the user asks what happened before, previous chats, prior work, or conversation continuity."
  ].join("\n");
}

function parseQueryPlan(text: string): MemoryV2QueryPlan | undefined {
  const match = text.trim().match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const desiredPredicates = Array.isArray(parsed.desiredPredicates)
      ? parsed.desiredPredicates
        .filter((predicate): predicate is string => typeof predicate === "string")
        .map((predicate) => predicate.trim())
        .filter(Boolean)
      : [];
    if (desiredPredicates.length === 0) return undefined;
    const querySubject = typeof parsed.querySubject === "string" && parsed.querySubject.trim()
      ? parsed.querySubject.trim()
      : undefined;
    return {
      ...(querySubject ? { querySubject } : {}),
      desiredPredicates: Array.from(new Set(desiredPredicates)),
      includeConversationHistory: parsed.includeConversationHistory === true
    };
  } catch {
    return undefined;
  }
}

function resolveQueryPlannerApiType(provider: string): ApiType {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "anthropic-compatible") return "anthropic-messages";
  if (normalized === "deepseek") return "deepseek-chat-completions";
  return "openai-completions";
}
