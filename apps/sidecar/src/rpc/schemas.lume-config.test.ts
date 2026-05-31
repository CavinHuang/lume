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
          guanlan: { enabled: true },
          duckduckgo: { enabled: false },
          bing: { enabled: true }
        }
      },
      summary: "update web search settings"
    });

    expect(result.success).toBeTrue();
  });
});
