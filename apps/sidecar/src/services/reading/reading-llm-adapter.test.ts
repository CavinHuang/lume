import { describe, expect, test } from "bun:test";
import { normalizeReadingSettings } from "@lume/shared";
import type { ReadingNoteGeneratorStreamRequest } from "./reading-note-generator";
import { createReadingNoteGeneratorLlm } from "./reading-llm-adapter";

describe("reading-llm-adapter", () => {
  test("selects the depth-specific reading model and maps provider responses into generator events", async () => {
    const providerCalls: unknown[] = [];
    const createdProviders: unknown[] = [];
    const attempt = createReadingNoteGeneratorLlm({
      depth: "deep",
      settings: normalizeReadingSettings({
        textModelMode: "explicit",
        textModelRef: "openai/gpt-5-mini",
        advanced: {
          seedModelRef: "openai/gpt-5-nano",
          deepModelRef: "deepseek/deep-reader"
        }
      }),
      resolveBinding(modelRef) {
        expect(modelRef).toBe("deepseek/deep-reader");
        return {
          channel: {
            id: "channel-1",
            provider: "deepseek",
            baseUrl: "https://api.deepseek.com"
          },
          modelId: "deep-reader"
        };
      },
      decryptApiKey(channelId) {
        expect(channelId).toBe("channel-1");
        return "test-key";
      },
      createProvider(options) {
        createdProviders.push(options);
        return {
          apiType: options.apiType,
          async createMessage(params) {
            providerCalls.push(params);
            return {
              content: [
                { type: "tool_use", id: "tc-memory", name: "alice_user_memory", input: { query: "普通生活" } },
                { type: "text", text: "{\"reflection\":\"Lume 把书和用户记忆连起来。\",\"quote\":\"把自己看作一个普通人。\"}" }
              ],
              stopReason: "tool_use",
              usage: {
                input_tokens: 21,
                output_tokens: 34
              }
            };
          }
        };
      }
    });

    expect(attempt?.modelRef).toBe("deepseek/deep-reader");
    const events = await collectEvents(attempt!.llm.stream(buildRequest()));

    expect(createdProviders).toEqual([{
      apiType: "deepseek-chat-completions",
      apiKey: "test-key",
      baseURL: "https://api.deepseek.com"
    }]);
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]).toMatchObject({
      model: "deep-reader",
      maxTokens: 1800,
      system: "system prompt",
      tools: [{
        name: "alice_user_memory",
        description: "Search memory",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string" }
          },
          required: ["query"]
        }
      }]
    });
    expect(events).toEqual([
      { type: "tool_call", id: "tc-memory", name: "alice_user_memory", arguments: { query: "普通生活" } },
      { type: "text", text: "{\"reflection\":\"Lume 把书和用户记忆连起来。\",\"quote\":\"把自己看作一个普通人。\"}" },
      {
        type: "usage",
        usage: {
          modelRef: "deepseek/deep-reader",
          promptTokens: 21,
          completionTokens: 34,
          totalTokens: 55
        }
      }
    ]);
  });

  test("falls back from depth-specific models to explicit text model and inherited chat model", () => {
    const resolved: string[] = [];
    const createAttempt = (modelRef: string) => createReadingNoteGeneratorLlm({
      depth: "seed",
      settings: normalizeReadingSettings({
        textModelMode: "explicit",
        textModelRef: "openai/gpt-5-mini"
      }),
      resolveBinding(ref) {
        resolved.push(ref);
        return {
          channel: {
            id: "channel-1",
            provider: "openai",
            baseUrl: "https://api.openai.com/v1"
          },
          modelId: ref.split("/").at(-1) ?? ref
        };
      },
      decryptApiKey: () => "test-key",
      createProvider: (options) => ({
        apiType: options.apiType,
        async createMessage() {
          return {
            content: [],
            stopReason: "end_turn",
            usage: { input_tokens: 0, output_tokens: 0 }
          };
        }
      }),
      getEffectiveConfig: () => ({
        models: {
          chat: {
            defaultModelRef: modelRef
          }
        }
      })
    });

    expect(createAttempt("openai/fallback-chat")?.modelRef).toBe("openai/gpt-5-mini");
    const inherited = createReadingNoteGeneratorLlm({
      depth: "seed",
      settings: normalizeReadingSettings({
        textModelMode: "inherit"
      }),
      resolveBinding(ref) {
        resolved.push(ref);
        return {
          channel: {
            id: "channel-1",
            provider: "openai",
            baseUrl: "https://api.openai.com/v1"
          },
          modelId: "fallback-chat"
        };
      },
      decryptApiKey: () => "test-key",
      createProvider: (options) => ({
        apiType: options.apiType,
        async createMessage() {
          return {
            content: [],
            stopReason: "end_turn",
            usage: { input_tokens: 0, output_tokens: 0 }
          };
        }
      }),
      getEffectiveConfig: () => ({
        models: {
          chat: {
            defaultModelRef: "openai/fallback-chat"
          }
        }
      })
    });

    expect(inherited?.modelRef).toBe("openai/fallback-chat");
    expect(resolved).toEqual([
      "openai/gpt-5-mini",
      "openai/fallback-chat"
    ]);
  });
});

function buildRequest(): ReadingNoteGeneratorStreamRequest {
  return {
    modelRef: "deepseek/deep-reader",
    caller: "reading-note-gen",
    messages: [
      { role: "system", content: "system prompt" },
      { role: "user", content: "user prompt" },
      {
        role: "assistant",
        content: "I need memory.",
        toolCalls: [{
          id: "tc-old",
          name: "alice_user_memory",
          arguments: { query: "旧查询" }
        }]
      },
      {
        role: "tool",
        toolCallId: "tc-old",
        name: "alice_user_memory",
        content: "memory result"
      }
    ],
    tools: [{
      name: "alice_user_memory",
      description: "Search memory",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" }
        },
        required: ["query"]
      }
    }]
  };
}

async function collectEvents<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}
