import { createHash } from "node:crypto";
import type { ApiType, PromptCachePolicy } from "@lume/agent-sdk";
import type { OpenAiApiMode } from "@lume/shared";

export function resolveSdkApiType(
  provider: string,
  openaiApiMode?: OpenAiApiMode,
): ApiType {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "google") {
    return "google-generative-ai";
  }
  if (normalized === "anthropic" || normalized === "anthropic-compatible") {
    return "anthropic-messages";
  }
  if (normalized === "deepseek") {
    return "deepseek-chat-completions";
  }
  if (openaiApiMode === "responses") {
    return "openai-responses";
  }
  return "openai-completions";
}

export function resolvePromptCachePolicy(input: {
  channelProvider?: string;
  provider: string;
  model: string;
  threadId: string;
  baseUrl?: string;
}): PromptCachePolicy {
  const channelProvider = (input.channelProvider ?? input.provider)
    .trim()
    .toLowerCase();
  const routingKey = `lume:v1:${createHash("sha256")
    .update(`${channelProvider}\0${input.model}\0${input.threadId}`)
    .digest("hex")}`;
  if (
    channelProvider === "anthropic" &&
    isOfficialEndpoint(input.baseUrl, "api.anthropic.com")
  ) {
    return {
      strategy: "anthropic-ephemeral",
      ttl: "5m",
      cacheStableSystem: true,
      cacheConversation: true,
      runtimeRole: "system",
    };
  }
  if (
    channelProvider === "openai" &&
    isOfficialEndpoint(input.baseUrl, "api.openai.com")
  ) {
    return { strategy: "implicit", routingKey, runtimeRole: "developer" };
  }
  if (channelProvider === "openrouter") {
    return {
      strategy: "openrouter-sticky",
      routingKey,
      runtimeRole: "system",
      ...(input.model.toLowerCase().startsWith("anthropic/")
        ? { ttl: "5m" as const, cacheStableSystem: true }
        : {}),
    };
  }
  if (channelProvider === "deepseek") {
    return { strategy: "implicit", runtimeRole: "user" };
  }
  return { strategy: "implicit", runtimeRole: "user" };
}

function isOfficialEndpoint(
  baseUrl: string | undefined,
  officialHost: string,
): boolean {
  if (!baseUrl?.trim()) return true;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === officialHost;
  } catch {
    return false;
  }
}
