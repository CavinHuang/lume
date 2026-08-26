import { describe, expect, test } from "bun:test";
import { lumeConfigUpdateInputSchema } from "./schemas";

describe("lume config rpc schemas", () => {
  test("accepts web search provider updates", () => {
    const result = lumeConfigUpdateInputSchema.safeParse({
      source: "user",
      path: "webSearch",
      value: {
        strategy: "priority",
        providers: {
          exa: { enabled: true },
          duckduckgo: { enabled: false },
          bing: { enabled: true }
        }
      },
      summary: "update web search settings"
    });

    expect(result.success).toBeTrue();
  });

  test("accepts memory extraction model updates", () => {
    const withValue = lumeConfigUpdateInputSchema.safeParse({
      source: "user",
      path: "memory.extraction.modelRef",
      value: "openai/gpt-4o-mini",
      summary: "update memory extraction model"
    });
    expect(withValue.success).toBeTrue();

    const cleared = lumeConfigUpdateInputSchema.safeParse({
      source: "user",
      path: "memory.extraction.modelRef",
      value: null,
      summary: "clear memory extraction model"
    });
    expect(cleared.success).toBeTrue();
  });

  test("accepts routine model updates", () => {
    const result = lumeConfigUpdateInputSchema.safeParse({
      source: "user",
      path: "models.routine.defaultModelRef",
      value: "openai/gpt-5-mini"
    });

    expect(result.success).toBeTrue();
  });

  test("accepts background task and image generation model updates", () => {
    expect(lumeConfigUpdateInputSchema.safeParse({
      source: "user",
      path: "models.title",
      value: { defaultModelRef: "openai/gpt-5-mini" }
    }).success).toBeTrue();

    expect(lumeConfigUpdateInputSchema.safeParse({
      source: "user",
      path: "models.imageGeneration",
      value: {
        priorityModelRefs: ["doubao/seedream"]
      }
    }).success).toBeTrue();

    expect(lumeConfigUpdateInputSchema.safeParse({
      source: "user",
      path: "models.contextWindows",
      value: { "openai/gpt-5-mini": 128000 }
    }).success).toBeTrue();
  });
});
