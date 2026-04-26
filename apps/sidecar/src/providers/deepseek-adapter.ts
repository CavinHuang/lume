import { OpenAIAdapter } from "./openai-adapter";
import type { ProviderRequest, StreamRequestInput } from "./types";

interface DeepSeekMessage {
  role?: string;
  content?: unknown;
  tool_calls?: unknown[];
}

function normalizeDeepSeekMessages(body: Record<string, unknown>): void {
  if (!Array.isArray(body.messages)) return;

  for (const message of body.messages) {
    if (!message || typeof message !== "object") continue;

    const item = message as DeepSeekMessage;
    if (item.role !== "assistant") continue;

    if (Array.isArray(item.tool_calls) && item.tool_calls.length === 0) {
      delete item.tool_calls;
    }

    if (Array.isArray(item.tool_calls) && item.tool_calls.length > 0 && item.content == null) {
      item.content = "";
    }
  }
}

export class DeepSeekAdapter extends OpenAIAdapter {
  readonly providerType = "deepseek" as const;

  buildStreamRequest(input: StreamRequestInput): ProviderRequest {
    const request = super.buildStreamRequest(input);
    const body = JSON.parse(request.body) as Record<string, unknown>;
    normalizeDeepSeekMessages(body);

    return {
      ...request,
      body: JSON.stringify(body),
    };
  }
}
